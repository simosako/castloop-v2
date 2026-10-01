import { describe, expect, test } from "bun:test";
import { stringifyToml } from "../packages/shared/src/index";
import worker from "./index";
import { initializeServiceAdmission, pauseServiceAdmission, readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";

const SERVICE = "schema_version = 1\nservice_id = 'service'\naccount_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nbucket_name = 'test-bucket'\nworker_name = 'test-worker'\nqueue_name = 'test-queue'\ndlq_name = 'test-dlq'\npublic_base_url = 'https://example.workers.dev'\n";

type RecordValue = { show_id: string; reservation_id: string };

function bucket() {
  const entries = new Map<string, string>([["system/service.toml", SERVICE]]);
  return {
    entries,
    put: async (key: string, value: string, options?: { onlyIf?: Headers | { etagMatches: string } }) => {
      if (options?.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && entries.has(key)) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== entries.get(key)) return null;
      entries.set(key, value);
      return { key, etag: value };
    },
    get: async (key: string) => {
      const value = entries.get(key);
      return value === undefined ? null : { etag: value, size: new TextEncoder().encode(value).length,
        json: async () => JSON.parse(value) as RecordValue, text: async () => value };
    },
    head: async (key: string) => entries.has(key) ? { key, etag: entries.get(key), size: new TextEncoder().encode(entries.get(key)!).length } : null,
  };
}

describe("Show ID reservation", () => {
  test("concurrent requests have one owner; only its retry succeeds", async () => {
    const storage = bucket();
    const env = { CASTLOOP_BUCKET: storage, CASTLOOP_ADMIN_KEY: "test-secret" };
    const claim = (id: string, secret = "test-secret") => worker.fetch(new Request(
      "https://example.workers.dev/admin/shows/reserve", {
        method: "POST", headers: { "X-Castloop-Key": secret },
        body: JSON.stringify({ show_id: "daily", reservation_id: id }),
      }), env as never);
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
    const results = await Promise.all(ids.map((id) => claim(id)));
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(11);
    const owner = JSON.parse(storage.entries.get("system/show-reservations/daily.json")!) as RecordValue;
    expect((await claim(owner.reservation_id)).status).toBe(200);
    expect((await claim(crypto.randomUUID())).status).toBe(409);
    expect((await claim(owner.reservation_id, "wrong-secret")).status).toBe(401);
  });
});

test("Show and Episode publication requests share one admission slot", async () => {
  const storage = bucket();
  const env = { CASTLOOP_BUCKET: storage, CASTLOOP_ADMIN_KEY: "test-secret" };
  const post = (path: string, body: object) => worker.fetch(new Request(`https://example.workers.dev${path}`, {
    method: "POST", headers: { "X-Castloop-Key": "test-secret" }, body: JSON.stringify(body),
  }), env as never);
  expect((await post("/admin/shows/reserve", { show_id: "daily", reservation_id: crypto.randomUUID() })).status).toBe(201);
  const showJob = crypto.randomUUID();
  const episodeJob = crypto.randomUUID();
  expect((await post("/admin/publications/claim", { show_id: "daily", job_id: showJob })).status).toBe(201);
  expect((await post("/admin/publications/claim", { show_id: "daily", job_id: episodeJob })).status).toBe(409);
  expect((await post("/admin/publications/claim", { show_id: "daily", job_id: showJob })).status).toBe(200);
  storage.entries.set("system/show-publications/daily.json", JSON.stringify({ job_id: episodeJob, state: "free" }));
  storage.entries.set(`system/jobs/${showJob}/status.toml`, "used");
  expect((await post("/admin/publications/claim", { show_id: "daily", job_id: showJob })).status).toBe(409);
});

test("concurrent Show-level publication claims admit exactly one job", async () => {
  const storage = bucket();
  const env = { CASTLOOP_BUCKET: storage, CASTLOOP_ADMIN_KEY: "test-secret" } as never;
  const post = (path: string, body: object) => worker.fetch(new Request(`https://example.workers.dev${path}`, {
    method: "POST", headers: { "X-Castloop-Key": "test-secret" }, body: JSON.stringify(body),
  }), env);
  await post("/admin/shows/reserve", { show_id: "daily", reservation_id: crypto.randomUUID() });
  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    post("/admin/publications/claim", { show_id: "daily", job_id: crypto.randomUUID() })));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 409)).toHaveLength(9);
});

test("public cover response advertises byte ranges with a known length", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const bucket = { get: async () => ({ size: bytes.length, body: new Blob([bytes]).stream() }) };
  const response = await worker.fetch(new Request("https://example.workers.dev/podcasts/daily/cover.jpg"),
    { CASTLOOP_BUCKET: bucket, CASTLOOP_ADMIN_KEY: "test-secret" } as never);
  expect(response.status).toBe(200);
  expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
});

test("a DLQ job left processing after a terminated invocation can be retried", async () => {
  const storage = bucket();
  const showId = "daily";
  const jobId = crypto.randomUUID();
  const markerKey = `staging/episodes/${showId}/large/${jobId}/commit.json`;
  storage.entries.set(`system/show-publications/${showId}.json`, JSON.stringify({ job_id: jobId, state: "processing" }));
  storage.entries.set(markerKey, "{}");
  storage.entries.set(`system/jobs/${jobId}/dlq.json`, "{}");
  storage.entries.set(`system/jobs/${jobId}/status.toml`, stringifyToml({ schema_version: 1,
    job_id: jobId, show_id: showId, episode_id: "large", kind: "episode", state: "processing" }));
  const sent: unknown[] = [];
  const env = { CASTLOOP_BUCKET: storage, CASTLOOP_QUEUE: { send: async (message: unknown) => { sent.push(message); } },
  CASTLOOP_ADMIN_KEY: "test-secret" } as never;
  const retry = () => worker.fetch(new Request("https://example.workers.dev/admin/jobs/retry", {
    method: "POST", headers: { "X-Castloop-Key": "test-secret" },
    body: JSON.stringify({ show_id: showId, episode_id: "large", kind: "episode", job_id: jobId }),
  }), env);
  expect((await retry()).status).toBe(202);
  expect(sent).toEqual([{ object: { key: markerKey } }]);
  storage.entries.delete(`system/jobs/${jobId}/dlq.json`);
  expect((await retry()).status).toBe(409);
});

test("paused service rejects legacy reservation/claim and malformed admission fails closed", async () => {
  const storage = bucket();
  const env = { CASTLOOP_BUCKET: storage, CASTLOOP_ADMIN_KEY: "test-secret" } as never;
  await initializeServiceAdmission(env, "service");
  await pauseServiceAdmission(env, "service", crypto.randomUUID());
  const before = new Map(storage.entries);
  for (const path of ["/admin/shows/reserve", "/admin/publications/claim"]) {
    const response = await worker.fetch(new Request(`https://example.workers.dev${path}`, { method: "POST",
      headers: { "X-Castloop-Key": "test-secret" }, body: JSON.stringify({ show_id: "daily", job_id: crypto.randomUUID(), reservation_id: crypto.randomUUID() }) }), env);
    expect(response.status).toBe(409);
  }
  expect(storage.entries).toEqual(before);
  storage.entries.set(SERVICE_ADMISSION_KEY, "{}");
  const response = await worker.fetch(new Request("https://example.workers.dev/admin/shows/reserve", { method: "POST",
    headers: { "X-Castloop-Key": "test-secret" }, body: JSON.stringify({ show_id: "daily", reservation_id: crypto.randomUUID() }) }), env);
  expect(response.status).toBe(503);
  expect(storage.entries.has("system/show-reservations/daily.json")).toBe(false);
});

test("live legacy queue invocation remains registered until its work settles", async () => {
  const storage = bucket();
  const env = { CASTLOOP_BUCKET: storage, CASTLOOP_ADMIN_KEY: "test-secret", CASTLOOP_DLQ_NAME: "dead-queue" } as never;
  await initializeServiceAdmission(env, "service");
  const jobId = crypto.randomUUID();
  const key = `staging/shows/daily/${jobId}/commit.json`;
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const liveEnv = { CASTLOOP_BUCKET: { ...storage, async get(path: string) {
    if (path === key) { started.resolve(); await ended.promise; }
    return storage.get(path);
  } }, CASTLOOP_ADMIN_KEY: "test-secret", CASTLOOP_DLQ_NAME: "dead-queue" } as never;
  const outcome = worker.queue({ queue: "main-queue", messages: [{ body: { object: { key } } }] } as never, liveEnv, {} as never);
  await started.promise;
  expect((await readServiceAdmission(env, "service"))?.value.invocations).toHaveLength(1);
  await pauseServiceAdmission(env, "service", crypto.randomUUID());
  ended.resolve();
  await outcome;
  expect((await readServiceAdmission(env, "service"))?.value.invocations).toEqual([]);
});
