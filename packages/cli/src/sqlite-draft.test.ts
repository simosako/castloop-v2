import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft, sqliteServiceConfigHash, stringifyToml } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import { SqliteDraft } from "./sqlite-draft";
import type { SqliteDraftTarget } from "./sqlite-draft-journal";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import type { R2RestTransport } from "./verified-r2-put";
import { SqlitePublicationAlarm } from "../../../src/sqlite-publication-alarm";
import { sqlitePublicationFixture } from "../../../src/test-support/sqlite-publication";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture(kind: "show" | "episode" = "episode", updating = false) {
  const root = mkdtempSync("/tmp/opencode/castloop-sqlite-cli-");
  const config: SqliteServiceConfig = { schema_version: 2, publication_protocol: "sqlite-sequential-v1", service_id: "service",
    account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "castloop-service",
    public_base_url: "https://podcasts.example.com", workers_dev_base_url: "https://castloop-service.example.workers.dev" };
  const setup = sqlitePublicationFixture({ runtime: { service_id: config.service_id,
    service_config_sha256: await sqliteServiceConfigHash(config), worker_version_id: crypto.randomUUID() } });
  cleanups.push(() => { setup.close(); rmSync(root, { recursive: true, force: true }); });
  const directory = join(root, "daily");
  mkdirSync(directory, { mode: 0o700 });
  const metadata = { schema_version: 1 as const, episode_id: "first", guid: "stable-guid", title: "Private title",
    description: "Private description", published_at: "2026-10-16T12:00:00Z" };
  const episodePath = join(directory, "episode-first.toml"), showPath = join(directory, "show.toml");
  writeFileSync(episodePath, stringifyToml(metadata));
  writeFileSync(showPath, stringifyToml({ schema_version: 1, show_id: "daily", title: "Private Show", description: "Private description",
    language: "ja", author: "Author", owner_name: "Owner", owner_email: "private@example.com", categories: ["Technology"],
    explicit: false, site_url: "https://example.com/podcast", image_path: "cover.jpg" }));
  const coverPath = join(directory, "cover.jpg"), audioPath = join(directory, "audio.mp3");
  writeFileSync(coverPath, Buffer.from([255, 216, 255, 2]));
  writeFileSync(audioPath, Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  const target: SqliteDraftTarget = { job_id: crypto.randomUUID(), kind, show_id: "daily", expected_show_state_version: 0,
    ...(kind === "episode" ? { episode_id: "first" } : {}),
    ...(kind === "episode" && updating ? { base_revision_id: crypto.randomUUID(),
      base_metadata_sha256: createHash("sha256").update(JSON.stringify(parseEpisodeDraft(readFileSync(episodePath, "utf8")))).digest("hex") } : {}) };
  const objects = new Map<string, { bytes: Uint8Array; etag: string; version: string }>();
  const calls: Array<{ method: string; key: string }> = [], management: string[] = [];
  const faults: { r2?: "lost" | "bad_hash" | "etag" | "partial" | "receipt" | "early" | "http";
    submit?: "lost_before" | "lost_after" | "http"; response?: (response: Response, request: Request) => Response | Promise<Response>;
    put?: () => Promise<void>; beforeSubmit?: () => Promise<void> } = {};
  const r2: R2RestTransport = async (input, init) => {
    const request = new Request(input, init), key = new URL(request.url).pathname.split("/objects/")[1]!;
    calls.push({ method: request.method, key });
    expect(request.headers.get("Authorization")).toBe("Bearer private-token");
    expect(init?.redirect).toBe("error");
    expect(request.headers.has("if-match")).toBe(false);
    expect(request.headers.has("if-none-match")).toBe(false);
    if (request.method === "PUT") {
      if (faults.r2 === "early") return Response.json({ success: true, result: { key, size: Number(request.headers.get("Content-Length")), etag: "etag", version: "version" } });
      const bytes = new Uint8Array(await request.arrayBuffer());
      const object = { bytes, etag: crypto.randomUUID(), version: crypto.randomUUID() };
      objects.set(key, object);
      await faults.put?.();
      if (faults.r2 === "lost") throw new Error("private-token arbitrary exception");
      if (faults.r2 === "http") return new Response("private-token", { status: 503 });
      return Response.json({ success: true, result: { key, size: bytes.length, etag: object.etag,
        ...(faults.r2 === "receipt" ? {} : { version: object.version }) } });
    }
    expect(request.method).toBe("GET");
    const object = objects.get(key)!;
    return new Response(faults.r2 === "bad_hash" ? new Uint8Array(object.bytes.length) : object.bytes,
      { status: faults.r2 === "partial" ? 206 : 200, headers: { ETag: `"${faults.r2 === "etag" ? "other" : object.etag}"`,
        ...(faults.r2 === "partial" ? { "Content-Range": `bytes 0-1/${object.bytes.length}` } : {}) } });
  };
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const transport: R2RestTransport = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    management.push(`${request.method} ${path}`);
    expect(new URL(request.url).origin).toBe(config.workers_dev_base_url);
    expect(request.headers.get("X-Castloop-Key")).toBe("private-admin");
    expect(request.headers.has("Authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    let response: Response;
    if (path.endsWith("/status")) {
      const snapshot = setup.queue.snapshot();
      response = json({ ...setup.runtime, protocol: "sqlite-sequential-v1", state: snapshot.state,
        admission_window_id: snapshot.admission_window_id, publication_ready: true });
    } else if (request.method === "POST") {
      await faults.beforeSubmit?.();
      if (faults.submit === "lost_before") throw new Error("private-admin lost response");
      if (faults.submit === "http") return json({ error: "private-admin" }, 503);
      const result = await setup.queue.enqueue(await request.json());
      if (faults.submit === "lost_after") throw new Error("private-admin lost response");
      response = json(result, 202);
    } else {
      const result = setup.queue.status(path.split("/").at(-1)!);
      response = result ? json(result) : json({ result: "not_found" }, 404);
    }
    return faults.response ? faults.response(response, request) : response;
  };
  const options = { administratorKey: "private-admin", managementTransport: transport,
    r2: { accountId: config.account_id, apiToken: "private-token", transport: r2 } };
  const draft = await SqliteDraft.open(root, config, target, options);
  const attemptRecords = () => {
    const folder = join(root, ".castloop", "sqlite-uploads", config.service_id);
    try { return readdirSync(folder).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(folder, name), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { ...setup, root, config, target, draft, options, calls, management, faults, objects, attemptRecords,
    episodePath, showPath, coverPath, audioPath,
    stage: async () => {
      if (kind === "show") await draft.stage({ asset: "show" });
      else { await draft.stage({ asset: "episode_metadata" }); await draft.stage({ asset: "audio", audio_path: "audio.mp3" }); }
    },
    alarm: () => new SqlitePublicationAlarm(setup.queue, { validate: async (request) => request, publish: async () => {} }, () => {}),
  };
}

for (const kind of ["show", "episode"] as const) {
  test(`SQLite ${kind} uploads only unique payload objects and requires explicit publish`, async () => {
    const setup = await fixture(kind);
    await setup.stage();
    const staged = await setup.draft.read();
    expect(staged.target.job_id).toBe(setup.target.job_id);
    expect(staged.assets).toHaveLength(2);
    expect(staged.publication).toBeUndefined();
    expect(setup.management).toEqual([]);
    expect(setup.queue.snapshot().drained).toBe(true);
    expect(setup.calls.map((call) => call.method)).toEqual(["PUT", "GET", "PUT", "GET"]);
    expect(setup.calls.every((call) => call.key.startsWith(`staging/uploads/daily/${setup.target.job_id}/`))).toBe(true);
    expect(new Set(setup.calls.filter((call) => call.method === "PUT").map((call) => call.key)).size).toBe(2);
    expect(staged.assets.every((entry) => entry.upload.verified && entry.upload.version)).toBe(true);
    setup.faults.beforeSubmit = async () => {
      const frozen = await setup.draft.read();
      expect(frozen.publication?.request.payloads).toEqual(staged.assets.map((entry) => entry.upload));
      expect(frozen.publication?.request_sha256).toHaveLength(64);
    };
    expect((await setup.draft.publish())?.state).toBe("queued");
    expect(setup.queue.snapshot().queued).toBe(1);
    const runner = setup.alarm();
    expect((await runner.alarm()).state).toBe("succeeded");
    expect((await setup.draft.wait()).state).toBe("succeeded");
    expect((await setup.draft.publish())?.state).toBe("succeeded");
    expect(setup.management.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(setup.calls).toHaveLength(4);
  });
}

test("metadata-only update reuses published audio without an MP3 PUT or server staging round trip", async () => {
  const setup = await fixture("episode", true);
  writeFileSync(setup.episodePath, readFileSync(setup.episodePath, "utf8").replace("Private title", "Updated title"));
  await setup.draft.stage({ asset: "episode_metadata" });
  expect(setup.management).toEqual([]);
  expect((await setup.draft.publish())?.state).toBe("queued");
  expect(setup.calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
  expect(setup.calls.some((call) => call.key.endsWith("audio.mp3"))).toBe(false);
  expect((await setup.draft.read()).publication?.request.base_revision_id).toBe(setup.target.base_revision_id);
});

test("audio-only update verifies local metadata against the frozen published base", async () => {
  const setup = await fixture("episode", true);
  await setup.draft.stage({ asset: "audio", audio_path: "audio.mp3" });
  expect((await setup.draft.publish())?.state).toBe("queued");
  const request = (await setup.draft.read()).publication!.request;
  expect(request.payloads.map((payload) => payload.asset)).toEqual(["audio"]);
  expect(request.payloads[0].duration_seconds).toBe(1);
});

test("audio-only cannot silently ignore local metadata edits", async () => {
  const setup = await fixture("episode", true);
  writeFileSync(setup.episodePath, readFileSync(setup.episodePath, "utf8").replace("Private title", "Unstaged edit"));
  await expect(setup.draft.stage({ asset: "audio", audio_path: "audio.mp3" })).rejects.toThrow("stage the current metadata");
  expect(setup.calls).toEqual([]);
  await setup.draft.stage({ asset: "episode_metadata" });
  await setup.draft.stage({ asset: "audio", audio_path: "audio.mp3" });
  expect((await setup.draft.publish())?.state).toBe("queued");
});

for (const fault of ["lost", "bad_hash", "etag", "partial", "receipt", "early", "http"] as const) {
  test(`unverified ${fault} upload stays out of the draft and never enqueues or retries`, async () => {
    const setup = await fixture();
    setup.faults.r2 = fault;
    await expect(setup.draft.stage({ asset: "episode_metadata" })).rejects.toThrow();
    expect((await setup.draft.read()).assets).toEqual([]);
    expect(setup.attemptRecords()).toHaveLength(1);
    expect(setup.attemptRecords()[0].state).toBe("put_requested");
    expect(setup.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(setup.management).toEqual([]);
    expect(setup.queue.snapshot().drained).toBe(true);
    const key = setup.calls[0].key;
    setup.faults.r2 = undefined;
    await setup.draft.stage({ asset: "episode_metadata" });
    expect(setup.calls.filter((call) => call.method === "PUT")[1].key).not.toBe(key);
    expect((await setup.draft.read()).target.job_id).toBe(setup.target.job_id);
  });
}

test("uploads remain owned and unreferenced until the PUT and full readback settle", async () => {
  const setup = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  setup.faults.put = async () => { enter(); await released; };
  const staging = setup.draft.stage({ asset: "episode_metadata" });
  await entered;
  try {
    expect((await setup.draft.read()).assets).toEqual([]);
    expect(setup.attemptRecords()[0].state).toBe("put_requested");
    await expect(setup.draft.publish()).rejects.toThrow();
    expect(setup.queue.snapshot().drained).toBe(true);
  } finally { release(); await staging; }
  expect(setup.attemptRecords()[0].state).toBe("verified");
  expect((await setup.draft.read()).assets).toHaveLength(1);
});

test("repeated editing preserves the draft ID but never overwrites a previous upload key", async () => {
  const setup = await fixture("episode", true);
  await setup.draft.stage({ asset: "episode_metadata" });
  const first = (await setup.draft.read()).assets[0].upload;
  writeFileSync(setup.episodePath, readFileSync(setup.episodePath, "utf8").replace("Private title", "Edited title"));
  await setup.draft.stage({ asset: "episode_metadata" });
  const second = (await setup.draft.read()).assets[0].upload;
  expect(second.key).not.toBe(first.key);
  expect(second.sha256).not.toBe(first.sha256);
  expect(setup.objects.has(first.key)).toBe(true);
  expect((await setup.draft.read()).target.job_id).toBe(setup.target.job_id);
  expect(setup.attemptRecords()).toHaveLength(2);
});

test("a partially uploaded Show pair is retained as an attempt but never becomes a draft manifest", async () => {
  const setup = await fixture("show");
  setup.faults.put = async () => {
    if (setup.calls.filter((call) => call.method === "PUT").length === 2) setup.faults.r2 = "lost";
  };
  await expect(setup.draft.stage({ asset: "show" })).rejects.toThrow();
  expect(setup.objects.size).toBe(2);
  expect((await setup.draft.read()).assets).toEqual([]);
  expect(setup.attemptRecords()[0].state).toBe("put_requested");
  expect(setup.management).toEqual([]);
});

test("hyphenated Show and Episode targets use distinct local draft identities", async () => {
  const setup = await fixture();
  const first = await SqliteDraft.open(setup.root, setup.config, { ...setup.target, show_id: "a-b", episode_id: "c" }, setup.options);
  const second = await SqliteDraft.open(setup.root, setup.config, { ...setup.target, show_id: "a", episode_id: "b-c" }, setup.options);
  expect((await first.read()).target).toMatchObject({ show_id: "a-b", episode_id: "c" });
  expect((await second.read()).target).toMatchObject({ show_id: "a", episode_id: "b-c" });
  expect(readdirSync(join(setup.root, ".castloop", "sqlite-drafts", setup.config.service_id)).filter((name) => name.endsWith(".json"))).toHaveLength(3);
});

for (const fault of ["lost_before", "lost_after", "http"] as const) {
  test(`submit ${fault} retains its frozen request and repeated publish only observes`, async () => {
    const setup = await fixture("episode", true);
    await setup.draft.stage({ asset: "episode_metadata" });
    setup.faults.submit = fault;
    await expect(setup.draft.publish()).rejects.toThrow();
    const frozen = (await setup.draft.read()).publication!;
    expect(frozen.status).toBeUndefined();
    setup.faults.submit = undefined;
    expect((await setup.draft.publish())?.state ?? null).toBe(fault === "lost_after" ? "queued" : null);
    expect((await setup.draft.read()).publication?.request).toEqual(frozen.request);
    expect(setup.management.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    await expect(setup.draft.stage({ asset: "episode_metadata" })).rejects.toThrow("frozen");
    await expect(SqliteDraft.open(setup.root, setup.config, { ...setup.target, job_id: crypto.randomUUID() }, setup.options)).rejects.toThrow("uncertain");
  });
}

test("initial incomplete or stale local drafts never submit", async () => {
  const setup = await fixture();
  await setup.draft.stage({ asset: "episode_metadata" });
  await expect(setup.draft.publish()).rejects.toThrow();
  expect((await setup.draft.read()).publication).toBeUndefined();
  await setup.draft.stage({ asset: "audio", audio_path: "audio.mp3" });
  writeFileSync(setup.episodePath, readFileSync(setup.episodePath, "utf8").replace("Private title", "Stale title"));
  await expect(setup.draft.publish()).rejects.toThrow("stage the current metadata");
  expect(setup.management.some((call) => call.startsWith("POST"))).toBe(false);
});

test("pause or mismatched capability prevents freezing or submitting a new request", async () => {
  const setup = await fixture("episode", true);
  await setup.draft.stage({ asset: "episode_metadata" });
  setup.queue.pause();
  await expect(setup.draft.publish()).rejects.toThrow("paused");
  setup.faults.response = async (response) => {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("Invalid fixture status");
    return Response.json({ ...value, service_config_sha256: "f".repeat(64) }, { headers: { "Cache-Control": "no-store" } });
  };
  await expect(setup.draft.publish()).rejects.toThrow("another service configuration");
  expect((await setup.draft.read()).publication).toBeUndefined();
  expect(setup.management.some((call) => call.startsWith("POST"))).toBe(false);
});

test("the same target cannot acquire a new draft ID until its known terminal result is archived", async () => {
  const setup = await fixture("episode", true);
  await expect(SqliteDraft.open(setup.root, setup.config, { ...setup.target, job_id: crypto.randomUUID() }, setup.options)).rejects.toThrow("unpublished");
  await expect(SqliteDraft.open(setup.root, setup.config, { ...setup.target, expected_show_state_version: 1 }, setup.options)).rejects.toThrow("original target");
  await setup.draft.stage({ asset: "episode_metadata" });
  await setup.draft.publish();
  await setup.alarm().alarm();
  await setup.draft.observe();
  const next = await SqliteDraft.open(setup.root, setup.config, { ...setup.target, job_id: crypto.randomUUID(),
    base_revision_id: crypto.randomUUID() }, setup.options);
  expect((await next.read()).assets).toEqual([]);
  const archive = JSON.parse(readFileSync(join(setup.root, ".castloop", "sqlite-publications", setup.config.service_id, `${setup.target.job_id}.json`), "utf8"));
  expect(archive.publication.status.state).toBe("succeeded");
  await expect(setup.draft.stage({ asset: "episode_metadata" })).rejects.toThrow("newer draft");
});

test("status rollback, body substitution and missing acknowledged jobs never erase retained results", async () => {
  const setup = await fixture("episode", true);
  await setup.draft.stage({ asset: "episode_metadata" });
  const queued = (await setup.draft.publish())!;
  setup.queue.claim();
  expect((await setup.draft.observe())?.state).toBe("running");
  for (const reply of [{ ...queued }, { ...queued, state: "running", sequence: queued.sequence + 1 },
    { ...queued, state: "running", request_sha256: "f".repeat(64) }]) {
    setup.faults.response = () => Response.json(reply, { headers: { "Cache-Control": "no-store" } });
    await expect(setup.draft.observe()).rejects.toThrow();
    expect((await setup.draft.read()).publication?.status?.state).toBe("running");
  }
  setup.faults.response = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  await expect(setup.draft.observe()).rejects.toThrow("Previously acknowledged");
});

test("waiting is bounded by 300 observations and never turns missing status into a POST", async () => {
  const setup = await fixture("episode", true);
  await setup.draft.stage({ asset: "episode_metadata" });
  setup.faults.submit = "lost_before";
  await expect(setup.draft.publish()).rejects.toThrow();
  let clock = 0;
  await expect(setup.draft.wait({ now: () => clock, delay: async (milliseconds) => { clock += milliseconds; } })).rejects.toThrow("waiting stopped");
  expect(setup.management.filter((call) => call.includes("GET /admin/sqlite-publication/jobs/"))).toHaveLength(300);
  expect(setup.management.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  let observations = 0;
  setup.faults.response = (response) => { observations++; clock += 300001; return response; };
  await expect(setup.draft.wait({ now: () => clock, delay: async () => {} })).rejects.toThrow("waiting stopped");
  expect(observations).toBe(1);
});

test("local oversize, invalid MP3, symlink, wrong metadata and wrong selection fail before PUT", async () => {
  const setup = await fixture();
  await expect(setup.draft.stage({ asset: "show" })).rejects.toThrow("selection");
  writeFileSync(setup.audioPath, "not an MP3");
  await expect(setup.draft.stage({ asset: "audio", audio_path: "audio.mp3" })).rejects.toThrow();
  truncateSync(setup.audioPath, 300_000_001);
  await expect(setup.draft.stage({ asset: "audio", audio_path: "audio.mp3" })).rejects.toThrow("size limit");
  const linked = join(setup.root, "daily", "linked.mp3");
  symlinkSync(setup.audioPath, linked);
  await expect(setup.draft.stage({ asset: "audio", audio_path: "linked.mp3" })).rejects.toThrow();
  writeFileSync(setup.episodePath, readFileSync(setup.episodePath, "utf8").replace('episode_id = "first"', 'episode_id = "other"'));
  await expect(setup.draft.stage({ asset: "episode_metadata" })).rejects.toThrow("another Episode");
  expect(setup.calls).toEqual([]);
  expect(setup.management).toEqual([]);
});

for (const response of [() => new Response("private-admin invalid JSON", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }),
  () => new Response("x".repeat(16385), { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }),
  () => Response.json({ secret: "private-admin" }),
  () => new Response("{}", { status: 206, headers: { "Content-Range": "bytes 0-1/2" } })]) {
  test("malformed, cacheable, oversized and partial management replies are not trusted or echoed", async () => {
    const setup = await fixture();
    const client = new SqlitePublicationClient(setup.config, "private-admin", async () => response());
    let error: unknown;
    try { await client.describe(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-admin");
  });
}
