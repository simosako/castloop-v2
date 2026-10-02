import { expect, test } from "bun:test";
import { stageUploadRequestSchema } from "@castloop/shared";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { readShowControl } from "../../../src/lifecycle-control";
import { fetchM6ManagementIntegration } from "../../../src/m6-routes";
import { publicationTestDigest } from "../../../src/test-support/episode-publication";
import { StagingAdminClient, stagingClientTargets } from "./staging-client";
import { createStagingJournal } from "./staging-journal";
import { runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import { createStagingRestEffects } from "./staging-rest-operation";
import { createStagingRestPut } from "./staging-rest";
import type { StagingRestTransport } from "./staging-rest";
import { freezeStagingSources } from "./staging-sources";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function fixture(kind: "show" | "audio" | "episode_metadata" = "audio") {
  const setup = await stagingAdminFixture(kind);
  const root = await mkdtemp("/tmp/opencode/castloop-rest-sources-");
  const paths = setup.contents.map((_, index) => join(root, `source-${index}`));
  for (let index = 0; index < paths.length; index += 1) await writeFile(paths[index]!, setup.contents[index]!.bytes);
  const sources = await freezeStagingSources(root, setup.upload, paths);
  const calls: Array<{ method: string; url: string; headers: Headers }> = [];
  const transport: StagingRestTransport = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ method: request.method, url: request.url, headers: request.headers });
    expect(init?.redirect).toBe("error");
    expect(request.headers.has("if-match")).toBe(false);
    expect(request.headers.has("if-none-match")).toBe(false);
    expect(request.headers.get("authorization")).toBe("Bearer private-token");
    const key = decodeURI(new URL(request.url).pathname.split("/objects/")[1]!);
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      await setup.bucket.put(key, bytes);
      return Response.json({ success: true, result: { size: bytes.length } });
    }
    const object = await setup.bucket.get(key);
    return new Response(object!.bytes);
  };
  const options = { accountId: setup.config.account_id, apiToken: "private-token", transport };
  return { ...setup, root, paths, sources, calls, options };
}

for (const kind of ["show", "audio", "episode_metadata"] as const) {
  test(`single REST PUT ${kind} uses exact private snapshots and checks full GET before settlement`, async () => {
    const setup = await fixture(kind);
    const journal = createStagingJournal(setup.root, setup.config, setup.upload);
    const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
      const response = await handleM6StagingAdmin(new Request(input, init), setup.env, setup.bindings, { digest: publicationTestDigest });
      return response!;
    });
    const effects = createStagingRestEffects(setup.config, journal.load(), "private-secret", setup.sources, setup.options, client);
    await runStagingClaim(journal, effects);
    expect(await runStagingBeginAndUpload(journal, effects)).toBe("staged");
    expect(setup.calls.map((call) => call.method)).toEqual(setup.upload.payloads.flatMap(() => ["PUT", "GET"]));
    for (let index = 0; index < setup.upload.payloads.length; index += 1) {
      expect(setup.calls[index * 2]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${setup.config.account_id}/r2/buckets/${setup.config.bucket_name}/objects/${stagingClientTargets(setup.upload)[index]!.key}`);
      expect(setup.calls[index * 2]!.headers.get("content-length")).toBe(String(setup.upload.payloads[index]!.length_bytes));
    }
    await runStagingSettle(journal, effects, { put_requests_settled: true, no_more_puts: true });
    await runStagingFinish(journal, effects);
    expect(journal.load().finish_receipt).toBe("staged");
    expect(await setup.bucket.head(`${stagingClientTargets(setup.upload)[0]!.key.replace(/\/[^/]+$/, "")}/commit.json`)).toBeNull();
    await setup.sources.dispose();
    expect((await readdir(join(setup.root, ".castloop"))).filter((name) => name.startsWith("upload-inputs-"))).toEqual([]);
    for (const path of setup.paths) expect(await readFile(path)).not.toHaveLength(0);
  });
}

test("snapshots are private, frozen, temporary and do not retain paths or metadata in journal", async () => {
  const setup = await fixture("show");
  const directory = (await readdir(join(setup.root, ".castloop"))).find((name) => name.startsWith("upload-inputs-"))!;
  expect((await stat(join(setup.root, ".castloop", directory))).mode & 0o777).toBe(0o700);
  expect((await stat(join(setup.root, ".castloop", directory, "0"))).mode & 0o777).toBe(0o400);
  expect(Object.isFrozen(setup.sources.upload.payloads[0])).toBe(true);
  const journal = createStagingJournal(setup.root, setup.config, setup.upload);
  const value = JSON.stringify(journal.load());
  expect(value).not.toContain(setup.paths[0]!);
  expect(value).not.toContain("private-token");
  await setup.sources.dispose();
  await setup.sources.dispose();
  await expect(setup.sources.assertCurrent()).rejects.toThrow("closed");
});

test("stale original and foreign PUT target are rejected before network; permission is never replayed", async () => {
  const setup = await fixture();
  const put = createStagingRestPut(setup.config, setup.sources, setup.options);
  const target = stagingClientTargets(setup.upload)[0]!;
  await expect(put({ ...target, key: "public/foreign.mp3" }, 0)).rejects.toThrow("exact one-time");
  await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes));
  await expect(put(target, 0)).rejects.toThrow("checksum");
  await expect(put(target, 0)).rejects.toThrow("one-time");
  expect(setup.calls).toEqual([]);
  await setup.sources.dispose();
});

test("stale local draft prevents claim/begin POST, even with unchanged file size", async () => {
  const setup = await fixture();
  const journal = createStagingJournal(setup.root, setup.config, setup.upload);
  let claims = 0;
  const client = new StagingAdminClient(setup.config, "private-key", async () => { claims += 1; throw new Error("Must not call"); });
  const effects = createStagingRestEffects(setup.config, journal.load(), "private-key", setup.sources, setup.options, client);
  const before = journal.load();
  await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes));
  await expect(runStagingClaim(journal, effects)).rejects.toThrow("checksum");
  expect(claims).toBe(0);
  expect(journal.load()).toEqual(before);
  expect(journal.load().phase).toBe("prepared");
  expect(setup.calls).toEqual([]);
  await setup.sources.dispose();
});

test("pre-send input rejection permits explicit same-journal claim and begin after restoring the frozen source", async () => {
  const setup = await fixture();
  const journal = createStagingJournal(setup.root, setup.config, setup.upload);
  const actions: string[] = [];
  const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    const request = new Request<unknown, IncomingRequestCfProperties>(new Request(input, init));
    actions.push((await request.clone().json<{ action: string }>()).action);
    return fetchM6ManagementIntegration(request, {
      CASTLOOP_BUCKET: setup.bucket as never, CASTLOOP_ADMIN_KEY: "private-secret", CASTLOOP_DLQ_NAME: setup.config.dlq_name,
      CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" }, CASTLOOP_QUEUE: {} as never,
    }, Object.assign(() => ({ fetch: async () => new Response() }), { invalidate: async () => {}, ...setup.bindings.cachedAssets }),
    { digest: publicationTestDigest });
  });
  const effects = createStagingRestEffects(setup.config, journal.load(), "private-secret", setup.sources, setup.options, client);
  try {
    await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes));
    await expect(runStagingClaim(journal, effects)).rejects.toThrow("checksum");
    expect(journal.load().phase).toBe("prepared");
    expect(actions).toEqual([]);
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
    await writeFile(setup.paths[0]!, setup.contents[0]!.bytes);
    await runStagingClaim(journal, effects);
    const claimed = journal.load();
    const owner = (await readShowControl(setup.env, "daily"))!.value.owner;
    await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes));
    await expect(runStagingBeginAndUpload(journal, effects)).rejects.toThrow("checksum");
    expect(journal.load()).toEqual(claimed);
    expect(actions).toEqual(["claim", "status"]);
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toEqual(owner);
    expect(setup.calls).toEqual([]);
    await writeFile(setup.paths[0]!, setup.contents[0]!.bytes);
    expect(await runStagingBeginAndUpload(journal, effects)).toBe("staged");
    await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes));
    await runStagingSettle(journal, effects, { put_requests_settled: true, no_more_puts: true });
    await runStagingFinish(journal, effects);
    expect(journal.load().phase).toBe("finished");
    expect(journal.load().finish_receipt).toBe("staged");
    expect(actions).toEqual(["claim", "status", "status", "begin", "status", "settle", "status", "finish"]);
    expect(setup.calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
  } finally { await setup.sources.dispose(); }
});

test("input failure after requested persistence never reopens a possibly consumed operation", async () => {
  const setup = await fixture();
  const journal = createStagingJournal(setup.root, setup.config, setup.upload);
  let checks = 0;
  let posts = 0;
  const sources = { ...setup.sources, assertCurrent: async () => {
    checks += 1;
    if (checks > 1) throw new Error("local input changed after requested persistence");
    await setup.sources.assertCurrent();
  } };
  const client = new StagingAdminClient(setup.config, "private-key", async () => { posts += 1; throw new Error("must not send"); });
  const effects = createStagingRestEffects(setup.config, journal.load(), "private-key", sources, setup.options, client);
  try {
    await expect(runStagingClaim(journal, effects)).rejects.toThrow("after requested persistence");
    expect(journal.load().phase).toBe("claim_requested");
    expect(checks).toBe(2);
    expect(posts).toBe(0);
    await expect(runStagingClaim(journal, effects)).rejects.toThrow("never replay");
    expect(checks).toBe(2);
    expect(posts).toBe(0);
    expect(setup.calls).toEqual([]);
  } finally { await setup.sources.dispose(); }
});

test("begin rechecks local sources after the read-only owner check and keeps unknown outcomes frozen", async () => {
  const setup = await fixture();
  const journal = createStagingJournal(setup.root, setup.config, setup.upload);
  const actions: string[] = [];
  let changeAfterStatus = false;
  const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    const request = new Request(input, init);
    const action = (await request.clone().json<{ action: string }>()).action;
    actions.push(action);
    const response = await handleM6StagingAdmin(request, setup.env, setup.bindings, { digest: publicationTestDigest });
    if (action === "status" && changeAfterStatus) await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes));
    return response!;
  });
  const effects = createStagingRestEffects(setup.config, journal.load(), "private-secret", setup.sources, setup.options, client);
  try {
    await runStagingClaim(journal, effects);
    changeAfterStatus = true;
    await expect(runStagingBeginAndUpload(journal, effects)).rejects.toThrow("checksum");
    expect(journal.load().phase).toBe("claimed");
    expect(actions).toEqual(["claim", "status"]);
    expect(setup.calls).toEqual([]);
    changeAfterStatus = false;
    await writeFile(setup.paths[0]!, setup.contents[0]!.bytes);
    await expect(runStagingBeginAndUpload(journal, { ...effects, begin: async () => {
      await effects.begin();
      throw new Error("unknown begin response");
    } })).rejects.toThrow("unknown begin response");
    expect(journal.load().phase).toBe("begin_requested");
    const before = actions.slice();
    await expect(runStagingBeginAndUpload(journal, { ...effects, checkLocalInputs: async () => {
      throw new Error("must not validate or replay an unknown begin");
    } })).rejects.toThrow("never reopen");
    expect(actions).toEqual(before);
    expect(setup.calls).toEqual([]);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("uploading");
  } finally { await setup.sources.dispose(); }
});

test("source validation rejects missing/oversize/symlink/directory before uploading and removes owned partial snapshots", async () => {
  const setup = await fixture();
  await setup.sources.dispose();
  const link = join(setup.root, "link");
  await symlink(setup.paths[0]!, link);
  for (const paths of [[], [join(setup.root, "missing")], [link], [setup.root]]) {
    await expect(freezeStagingSources(setup.root, setup.upload, paths)).rejects.toThrow();
  }
  await writeFile(setup.paths[0]!, new Uint8Array(setup.upload.payloads[0]!.length_bytes + 1));
  await expect(freezeStagingSources(setup.root, setup.upload, setup.paths)).rejects.toThrow("size/type");
  expect(() => stageUploadRequestSchema.parse({ ...setup.upload, payloads: [{ ...setup.upload.payloads[0], length_bytes: 300000001 }] })).toThrow();
  expect(await readdir(join(setup.root, ".castloop"))).toEqual([]);
  expect(setup.calls).toEqual([]);
});

test("REST credentials cannot target another account and session must match durable manifest", async () => {
  const setup = await fixture();
  expect(() => createStagingRestPut(setup.config, setup.sources, { ...setup.options, accountId: "f".repeat(32) })).toThrow("account");
  expect(() => createStagingRestPut(setup.config, setup.sources, { ...setup.options, apiToken: "token\n" })).toThrow("credentials");
  const journal = createStagingJournal(setup.root, setup.config, { ...setup.upload, draft_job_id: crypto.randomUUID() });
  expect(() => createStagingRestEffects(setup.config, journal.load(), "key", setup.sources, setup.options)).toThrow("durable frozen");
  await setup.sources.dispose();
});

for (const failure of ["early", "lost", "http", "oversized", "receipt", "hash", "range"] as const) {
  test(`REST ${failure} failure never retries PUT or returns arbitrary API diagnostics`, async () => {
    const setup = await fixture();
    const calls: string[] = [];
    let cancelled = false;
    const transport: StagingRestTransport = async (input, init) => {
      calls.push(init!.method!);
      if (init!.method === "PUT") {
        if (failure !== "early") await new Request(input, init).arrayBuffer();
        if (failure === "lost") throw new Error("private-token arbitrary server exception");
        if (failure === "http") return new Response("private-token", { status: 403 });
        if (failure === "oversized") return new Response("x".repeat(65537));
        return Response.json({ success: true, result: { size: failure === "receipt" ? 1 : setup.upload.payloads[0]!.length_bytes } });
      }
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(setup.upload.payloads[0]!.length_bytes)); if (failure !== "range") controller.close(); }, cancel() { cancelled = true; } }),
        failure === "range" ? { status: 206, headers: { "content-range": "bytes 0-1/2" } } : undefined);
    };
    const put = createStagingRestPut(setup.config, setup.sources, { ...setup.options, transport, timeoutMs: 20 });
    await expect(put(stagingClientTargets(setup.upload)[0]!, 0)).rejects.toThrow("no automatic retry");
    expect(calls.filter((method) => method === "PUT")).toHaveLength(1);
    await expect(put(stagingClientTargets(setup.upload)[0]!, 0)).rejects.toThrow("one-time");
    if (failure === "range") expect(cancelled).toBe(true);
    await setup.sources.dispose();
  });
}

test("owned network/GET cancellation remains awaited and snapshots cannot be disposed while active", async () => {
  const setup = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const transport: StagingRestTransport = async (input, init) => {
    if (init!.method === "PUT") return setup.options.transport(input, init);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(setup.upload.payloads[0]!.length_bytes + 1)); },
      async cancel() { enter(); await released; } }));
  };
  const put = createStagingRestPut(setup.config, setup.sources, { ...setup.options, transport });
  const running = put(stagingClientTargets(setup.upload)[0]!, 0);
  await entered;
  await expect(setup.sources.dispose()).rejects.toThrow("active");
  let ended = false;
  const observed = running.catch(() => { ended = true; });
  await Promise.resolve();
  expect(ended).toBe(false);
  release();
  await observed;
  expect(ended).toBe(true);
  await setup.sources.dispose();
});

test("native Bun streaming HTTP uses a pinned snapshot even when the editable original changes mid-PUT", async () => {
  const setup = await fixture();
  await setup.sources.dispose();
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(73);
  await writeFile(setup.paths[0]!, bytes);
  const upload = stageUploadRequestSchema.parse({ ...setup.upload, payloads: [{ asset: "audio", length_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }] });
  const sources = await freezeStagingSources(setup.root, upload, setup.paths);
  let puts = 0;
  let reads = 0;
  let received: Uint8Array | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "PUT") {
      puts += 1;
      expect(request.headers.get("content-length")).toBe(String(bytes.length));
      await writeFile(setup.paths[0]!, new Uint8Array(bytes.length));
      received = new Uint8Array(await request.arrayBuffer());
      return Response.json({ success: true, result: { size: received.length } });
    }
    reads += 1;
    return new Response(received);
  } });
  try {
    const transport: StagingRestTransport = (input, init) => fetch(new URL(new URL(String(input)).pathname, server.url), init);
    const put = createStagingRestPut(setup.config, sources, { ...setup.options, transport });
    await put(stagingClientTargets(upload)[0]!, 0);
    expect(puts).toBe(1);
    expect(reads).toBe(1);
    expect(createHash("sha256").update(received!).digest("hex")).toBe(upload.payloads[0]!.sha256);
    await expect(sources.assertCurrent()).rejects.toThrow("checksum");
    await expect(put(stagingClientTargets(upload)[0]!, 0)).rejects.toThrow("one-time");
  } finally { await server.stop(true); await sources.dispose(); }
});
