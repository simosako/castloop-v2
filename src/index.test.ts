import { describe, expect, test } from "bun:test";
import worker from "./index";

type RecordValue = { show_id: string; reservation_id: string };

function bucket() {
  const entries = new Map<string, string>();
  return {
    entries,
    put: async (key: string, value: string, options: { onlyIf: Headers }) => {
      if (options.onlyIf.get("If-None-Match") === "*" && entries.has(key)) return null;
      entries.set(key, value);
      return { key };
    },
    get: async (key: string) => entries.has(key) ? { json: async () => JSON.parse(entries.get(key)!) as RecordValue } : null,
    head: async (key: string) => entries.has(key) ? { key } : null,
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
