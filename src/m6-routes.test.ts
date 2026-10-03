import { describe, expect, test } from "bun:test";
import { parseEpisodeLifecycle, parseEpisodeRevision, parseJobStatus, serviceCapabilitiesSchema } from "../packages/shared/src/index";
import { commitOwnedLifecycleOperation } from "./lifecycle-commit";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { describeCachedDeliveryRuntime } from "./lifecycle-delivery-gate";
import { runLifecycleMigrationStep } from "./lifecycle-migration-apply";
import { fetchM6Candidate, queueM6Candidate } from "./m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "./m6-routes";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { migrationFixture } from "./test-support/migration";
import { publicationFixture } from "./test-support/publication";
import { episodePublicationFixture, publicationTestDigest } from "./test-support/episode-publication";

const feedPath = "/podcasts/daily/feed.xml";
const request = (path = feedPath, method = "GET", headers: HeadersInit = {}) =>
  new Request<unknown, IncomingRequestCfProperties>(`https://current.example${path}`, { method, headers });
const batch = (key: string, queue = "test-queue") => ({ queue, messages: [{ id: "message-1", body: { object: { key } } }] }) as never;

async function fixture() {
  const setup = await migrationFixture();
  for (let index = 0; index < 3; index += 1) await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
  const events: Array<{ method: string; props?: object; request?: Request }> = [];
  let status = 200;
  const loopback = Object.assign(({ props }: { props: object }) => ({ async fetch(input: Request) {
    events.push({ method: "fetch", props, request: input });
    return new Response(status === 304 ? null : "cached bytes", { status, headers: { "Cache-Control": "public, max-age=300", "Cache-Tag": "internal", "ETag": '"test"' } });
  } }), {
    async invalidate() { events.push({ method: "purge" }); },
    async describeRuntime() { events.push({ method: "runtime" });
      return describeCachedDeliveryRuntime({ id: setup.runtime.worker_version_id }, { purge: async () => ({ success: true, errors: [] }) }); },
  }) satisfies M6CachedLoopback;
  const sent: unknown[] = [];
  const env: M6CandidateEnv = { CASTLOOP_BUCKET: setup.bucket, CASTLOOP_DLQ_NAME: "test-dlq", CASTLOOP_ADMIN_KEY: "private-secret",
    CASTLOOP_VERSION_METADATA: { id: setup.runtime.worker_version_id, tag: "", timestamp: "2026-10-01T12:00:00Z" },
    CASTLOOP_QUEUE: { send: async (input: unknown) => { sent.push(input); } } } as never;
  return { ...setup, env, events, loopback, sent, setStatus: (input: number) => { status = input; } };
}

describe("M6 candidate state-first gateway", () => {
  test("public GET/HEAD/Range/validators use normalized loopback props after readiness/state checks", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    const response = await fetchM6Candidate(request(`${feedPath}?tracking=private`, "GET", { Cookie: "private-cookie", "X-Castloop-Key": "private-secret", "If-None-Match": '"test"' }), setup.env, setup.loopback);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(setup.events[0]?.props).toEqual({ showGeneration: 0, feedGeneration: 0 });
    expect(setup.events[0]?.request?.url).toBe(`https://castloop-cache.invalid${feedPath}`);
    expect(setup.events[0]?.request?.headers.get("Cookie")).toBeNull();
    expect(setup.events[0]?.request?.headers.get("X-Castloop-Key")).toBeNull();
    expect(setup.events[0]?.request?.headers.get("If-None-Match")).toBe('"test"');
    expect(await (await fetchM6Candidate(request(feedPath, "HEAD"), setup.env, setup.loopback)).text()).toBe("");
    const audioKey = [...setup.entries.keys()].find((key) => key.endsWith(".mp3"))!;
    const audio = await fetchM6Candidate(request(audioKey.slice("public".length), "GET", { Range: "bytes=0-1" }), setup.env, setup.loopback);
    expect(audio.status).toBe(200);
    expect(setup.events.at(-1)?.props).toEqual({ showGeneration: 0, episodeGeneration: 0 });
    expect(setup.events.at(-1)?.request?.headers.get("Range")).toBe("bytes=0-1");
    expect(setup.entries).toEqual(before);
  });

  test("cached responses and 304 never bypass stop/deletion state or corrupt controls", async () => {
    const setup = await fixture();
    setup.setStatus(304);
    expect((await fetchM6Candidate(request(), setup.env, setup.loopback)).status).toBe(304);
    const calls = setup.events.length;
    for (const [state, status] of [["unpublished", 404], ["deleting", 410], ["deleted", 410]] as const) {
      await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily", lifecycle: state, generation: 1, feed_generation: 1 }));
      const result = await fetchM6Candidate(request(feedPath, "HEAD", { "If-None-Match": '"test"' }), setup.env, setup.loopback);
      expect(result.status).toBe(status);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(await result.text()).toBe("");
    }
    await setup.bucket.put("system/show-publications/daily.json", "{}");
    expect((await fetchM6Candidate(request(), setup.env, setup.loopback)).status).toBe(503);
    expect(setup.events.length).toBe(calls);
  });

  test("missing/legacy migration readiness and foreign Worker versions never use legacy public delivery", async () => {
    for (const failure of ["missing", "legacy", "version", "dlq"] as const) {
      const setup = await fixture();
      if (failure === "missing") setup.entries.delete(SERVICE_ADMISSION_KEY);
      if (failure === "legacy") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ schema_version: 1, service_id: "service", mode: "legacy", state: "open", generation: 0, invocations: [] }));
      if (failure === "version") setup.env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
      if (failure === "dlq") setup.env.CASTLOOP_DLQ_NAME = "another-dlq";
      expect((await fetchM6Candidate(request(), setup.env, setup.loopback)).status).toBe(503);
      expect(setup.events).toEqual([]);
    }
  });

  test("private/unsupported routes never reach loopback; candidate admin mutations remain disabled", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    for (const path of ["/system/service.toml", "/staging/shows/daily/draft/show.toml", "/podcasts/daily/not-public.json"]) {
      expect((await fetchM6Candidate(request(path), setup.env, setup.loopback)).status).toBe(404);
    }
    expect((await fetchM6Candidate(request(feedPath, "POST"), setup.env, setup.loopback)).status).toBe(405);
    expect((await fetchM6Candidate(request("/admin/capabilities"), setup.env, setup.loopback)).status).toBe(401);
    for (const path of ["/admin/shows/reserve", "/admin/publications/claim", "/admin/jobs/retry", "/admin/lifecycle/delete"]) {
      expect((await fetchM6Candidate(request(path, "POST", { "X-Castloop-Key": "private-secret" }), setup.env, setup.loopback)).status).toBe(409);
    }
    const response = await fetchM6Candidate(request("/admin/capabilities", "GET", { "X-Castloop-Key": "private-secret" }), setup.env, setup.loopback);
    const capability = serviceCapabilitiesSchema.parse(await response.json());
    expect(capability.worker_protocol).toBe("m6_candidate");
    expect(capability.features.lifecycle_delivery).toBe(true);
    expect(capability.features.lifecycle_commands).toBe(false);
    expect(capability.legacy_mutations_admitted).toBe(false);
    expect(capability.m6_ready).toBe(false);
    expect(setup.entries).toEqual(before);
    expect(setup.events).toEqual([]);
  });

  test("internal cache failure returns no-store 503 and never falls back to stored legacy feed", async () => {
    const setup = await fixture();
    const loopback = Object.assign(() => ({ fetch: async () => { throw new Error("Private cache error details"); } }), {
      invalidate: setup.loopback.invalidate, describeRuntime: setup.loopback.describeRuntime,
    }) satisfies M6CachedLoopback;
    const response = await fetchM6Candidate(request(), setup.env, loopback);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("legacy feed");
    expect(body).not.toContain("Private cache error");
  });
});

describe("M6 candidate Queue routing and common service fence", () => {
  test("lifecycle commit routes through both invocation tokens and internal purge", async () => {
    const setup = await fixture();
    const jobId = crypto.randomUUID();
    const control = await claimShowOperation(setup.env, { schema_version: 1, kind: "show", action: "unpublish", show_id: "daily", job_id: jobId,
      expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z" });
    const marker = await commitOwnedLifecycleOperation(setup.env, { showId: "daily", jobId, generation: control.value.generation });
    await queueM6Candidate(batch(marker.key), setup.env, setup.loopback);
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("unpublished");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    expect(setup.events.filter((event) => event.method === "purge")).toHaveLength(1);
    expect((await fetchM6Candidate(request(), setup.env, setup.loopback)).status).toBe(404);
    expect(setup.events.some((event) => event.method === "fetch")).toBe(false);
  });

  test("Show publication uses the new frozen manifest consumer rather than the legacy publisher", async () => {
    const setup = await fixture();
    const publication = await publicationFixture();
    await publication.bucket.put(SERVICE_ADMISSION_KEY, setup.entries.get(SERVICE_ADMISSION_KEY)!.data);
    const env: M6CandidateEnv = { ...setup.env, CASTLOOP_BUCKET: publication.bucket } as never;
    await queueM6Candidate(batch(publication.key), env, setup.loopback);
    expect(parseJobStatus(publication.text(publication.statusKey)).schema_version).toBe(2);
    expect(parseJobStatus(publication.text(publication.statusKey)).state).toBe("published");
    expect(publication.text(publication.feedKey)).toContain("New Show title");
    expect((await readShowControl(env, "daily"))?.value.lifecycle).toBe("active");
    expect((await readServiceAdmission(env, "service"))?.value.invocations).toEqual([]);
    expect(setup.events.filter((event) => event.method === "purge")).toHaveLength(1);
  });

  test("live internal purge keeps both service and Show execution tokens until all work settles", async () => {
    const setup = await fixture();
    const jobId = crypto.randomUUID();
    const control = await claimShowOperation(setup.env, { schema_version: 1, kind: "show", action: "unpublish", show_id: "daily", job_id: jobId,
      expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z" });
    const marker = await commitOwnedLifecycleOperation(setup.env, { showId: "daily", jobId, generation: control.value.generation });
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const loopback = Object.assign(setup.loopback, { invalidate: async () => { started.resolve(); await ended.promise; } });
    const outcome = queueM6Candidate(batch(marker.key), setup.env, loopback);
    await started.promise;
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(1);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeDefined();
    ended.resolve();
    await outcome;
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("DLQ delivery records a sanitized marker but never changes job status or operation ownership", async () => {
    const setup = await fixture();
    const jobId = crypto.randomUUID();
    const control = await claimShowOperation(setup.env, { schema_version: 1, kind: "show", action: "unpublish", show_id: "daily", job_id: jobId,
      expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z" });
    const marker = await commitOwnedLifecycleOperation(setup.env, { showId: "daily", jobId, generation: control.value.generation });
    const before = setup.entries.get("system/show-publications/daily.json");
    await queueM6Candidate(batch(marker.key, "test-dlq"), setup.env, setup.loopback);
    expect(setup.entries.get("system/show-publications/daily.json")).toEqual(before);
    expect(setup.entries.has(`system/jobs/${jobId}/status.toml`)).toBe(false);
    expect(JSON.parse(setup.entries.get(`system/jobs/${jobId}/dlq.json`)!.data)).toEqual({ key: marker.key });
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("unknown Queue and wrong readiness version reject before registry writes or job work", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    const key = `staging/shows/daily/${crypto.randomUUID()}/commit.json`;
    await expect(queueM6Candidate(batch(key, "unknown"), setup.env, setup.loopback)).rejects.toThrow("unknown Queue");
    setup.env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
    await expect(queueM6Candidate(batch(key), setup.env, setup.loopback)).rejects.toThrow("Worker version");
    expect(setup.entries).toEqual(before);
    expect(setup.events).toEqual([]);
  });

  test("cache owner runtime failure returns known tokens but keeps the publication owner blocked", async () => {
    const setup = await fixture();
    const publication = await publicationFixture();
    await publication.bucket.put(SERVICE_ADMISSION_KEY, setup.entries.get(SERVICE_ADMISSION_KEY)!.data);
    const env: M6CandidateEnv = { ...setup.env, CASTLOOP_BUCKET: publication.bucket } as never;
    const loopback = Object.assign(setup.loopback, { describeRuntime: async () => { throw new Error("Internal runtime unavailable"); } });
    await expect(queueM6Candidate(batch(publication.key), env, loopback)).rejects.toThrow("runtime unavailable");
    expect((await readShowControl(env, "daily"))?.value.lifecycle).toBe("draft");
    expect((await readShowControl(env, "daily"))?.value.owner?.job_id).toBe(publication.operation.jobId);
    expect((await readShowControl(env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    expect((await readServiceAdmission(env, "service"))?.value.invocations).toEqual([]);
    expect(publication.entries.has(publication.feedKey)).toBe(false);
  });

  test("initial/metadata-only/audio-only Episode publications route through the shared new consumer", async () => {
    for (const update of [undefined, "metadata", "audio"] as const) {
      const setup = await fixture();
      const publication = await episodePublicationFixture(update);
      await publication.bucket.put(SERVICE_ADMISSION_KEY, setup.entries.get(SERVICE_ADMISSION_KEY)!.data);
      const env: M6CandidateEnv = { ...setup.env, CASTLOOP_BUCKET: publication.bucket } as never;
      await queueM6Candidate(batch(publication.key), env, setup.loopback, { digest: publicationTestDigest });
      expect(parseJobStatus(publication.text(publication.statusKey)).state).toBe("published");
      expect(parseEpisodeLifecycle(publication.text(publication.lifecycleKey)).lifecycle).toBe("active");
      const revision = parseEpisodeRevision(publication.text(publication.metadataKey));
      expect(revision.guid).toBe(publication.base?.guid ?? publication.draft.guid);
      expect(revision.revision_id).toBe(publication.operation.jobId);
      expect((await readServiceAdmission(env, "service"))?.value.invocations).toEqual([]);
      expect((await readShowControl(env, "daily"))?.value.owner).toBeUndefined();
      expect(setup.events.filter((event) => event.method === "purge")).toHaveLength(1);
    }
  });

  test("bounded Show deletion requeues the same frozen job, closes delivery and retains tombstones/status", async () => {
    const setup = await fixture();
    const jobId = crypto.randomUUID();
    const control = await claimShowOperation(setup.env, { schema_version: 1, kind: "show", action: "delete", show_id: "daily", job_id: jobId,
      expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z" });
    const marker = await commitOwnedLifecycleOperation(setup.env, { showId: "daily", jobId, generation: control.value.generation });
    let finished = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await queueM6Candidate(batch(marker.key), setup.env, setup.loopback, { maximumObjects: 1 });
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
      expect((await fetchM6Candidate(request(), setup.env, setup.loopback)).status).toBe(410);
      const current = (await readShowControl(setup.env, "daily"))!.value;
      if (!current.owner) { finished = true; break; }
      expect(current.owner.execution_id).toBeUndefined();
    }
    expect(finished).toBe(true);
    expect(setup.sent.length).toBeGreaterThan(0);
    for (const continuation of setup.sent) expect(continuation).toEqual({ object: { key: marker.key } });
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("deleted");
    expect([...setup.entries.keys()].filter((key) => key.startsWith("public/"))).toEqual([]);
    expect(parseEpisodeLifecycle(setup.entries.get("system/episode-lifecycle/daily/first.toml")!.data).lifecycle).toBe("deleted");
    expect(parseJobStatus(setup.entries.get(`system/jobs/${jobId}/status.toml`)!.data).state).toBe("completed");
    expect(setup.entries.has("system/show-reservations/daily.json")).toBe(true);
    expect(setup.entries.has(marker.key)).toBe(true);
    expect(setup.events.some((event) => event.method === "fetch")).toBe(false);
  });

  test("unknown primary notification is ignored and unmatched DLQ stores only an allowlisted reason", async () => {
    const setup = await fixture();
    const message = { id: "safe-id", body: { title: "Private title", token: "Private token" } };
    const before = new Map(setup.entries);
    await queueM6Candidate({ queue: "test-queue", messages: [message] } as never, setup.env, setup.loopback);
    expect(setup.entries).toEqual(before);
    await queueM6Candidate({ queue: "test-dlq", messages: [message] } as never, setup.env, setup.loopback);
    expect(JSON.parse(setup.entries.get("system/dlq/unmatched/safe-id.json")!.data)).toEqual({ schema_version: 1, reason_code: "unmatched_queue_delivery" });
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("multi-message batches reject before any registry or job effects", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    await expect(queueM6Candidate({ queue: "test-queue", messages: [{}, {}] } as never, setup.env, setup.loopback)).rejects.toThrow("one-message");
    expect(setup.entries).toEqual(before);
    expect(setup.events).toEqual([]);
  });

  test("legacy commit markers without frozen M6 publication manifests are never promoted or republished", async () => {
    const setup = await fixture();
    const key = `staging/shows/daily/${setup.jobId}/commit.json`;
    await setup.bucket.put(key, JSON.stringify({ schema_version: 1, kind: "show", show_id: "daily", job_id: setup.jobId,
      metadata_sha256: "a".repeat(64), cover_sha256: "b".repeat(64), cover_extension: "jpg" }));
    const before = new Map(setup.entries);
    await queueM6Candidate(batch(key), setup.env, setup.loopback);
    for (const [path, entry] of before) if (path !== SERVICE_ADMISSION_KEY) expect(setup.entries.get(path)).toEqual(entry);
    expect(setup.events).toEqual([]);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("service token acquisition response loss keeps an unknown token and does not start the consumer", async () => {
    const setup = await fixture();
    const publication = await publicationFixture();
    await publication.bucket.put(SERVICE_ADMISSION_KEY, setup.entries.get(SERVICE_ADMISSION_KEY)!.data);
    const bucket = { ...publication.bucket, async put(...args: Parameters<typeof publication.bucket.put>) {
      const result = await publication.bucket.put(...args);
      if (result && args[0] === SERVICE_ADMISSION_KEY && typeof args[1] === "string" && args[1].includes('"m6_consumer"')) throw new Error("Service token response lost");
      return result;
    } };
    const env: M6CandidateEnv = { ...setup.env, CASTLOOP_BUCKET: bucket } as never;
    await expect(queueM6Candidate(batch(publication.key), env, setup.loopback)).rejects.toThrow("response lost");
    expect((await readServiceAdmission(env, "service"))?.value.invocations).toHaveLength(1);
    expect((await readShowControl(env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    expect(publication.entries.has(publication.feedKey)).toBe(false);
    expect(setup.events).toEqual([]);
  });
});
