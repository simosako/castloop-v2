import { expect, spyOn, test } from "bun:test";
import { episodeDraftFromRevision, parseEpisodeRevision, stringifyToml } from "@castloop/shared";
import type { ManagementIntent } from "@castloop/shared";
import { asyncManagementFixture } from "../../../src/test-support/async-management";
import { ManagementQueueClient } from "./management-queue-client";
import { updateLocalM6Draft, publishLocalM6Draft } from "./m6-local-update";
import { readRemoteOperationStatus } from "./remote-operation-status";
import { readLocalDraft } from "./local-draft-journal";
import { readLocalStagingOperation } from "./staging-journal";
import { readLocalPublicationJob } from "./publication-journal";
import { RSS_IMPORT_AUDIO } from "./test-support/rss-import";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function harness() {
  const setup = await asyncManagementFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-async-management-");
  mkdirSync(join(root, "daily"));
  writeFileSync(join(root, "daily", "show.toml"), setup.contents[0]!.bytes);
  writeFileSync(join(root, "daily", "cover.jpg"), setup.contents[1]!.bytes);
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID, previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = setup.config.account_id;
  process.env.CLOUDFLARE_API_TOKEN = "test-rest-token";
  const messages: ManagementIntent[] = [];
  const requests: string[] = [];
  let loseSubmission: ManagementIntent["command"]["action"] | undefined;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.hostname !== "api.cloudflare.com") throw new Error("Content management must not invoke castloop HTTP");
    if (url.pathname.endsWith("/queues")) return Response.json({ success: true,
      result: [{ queue_id: "1".repeat(32), queue_name: setup.config.queue_name }] });
    if (url.pathname.endsWith(`/queues/${"1".repeat(32)}`)) return Response.json({ success: true,
      result: { queue_id: "1".repeat(32), queue_name: setup.config.queue_name } });
    if (url.pathname.endsWith("/consumers")) return Response.json({ success: true, result: [{ script_name: setup.config.worker_name,
      dead_letter_queue: setup.config.dlq_name, settings: { batch_size: 1, max_concurrency: 1, max_retries: 2 } }] });
    if (url.pathname.endsWith("/messages")) {
      const intent = JSON.parse(String(init?.body)).body as ManagementIntent;
      messages.push(intent);
      await setup.deliver(intent);
      if (loseSubmission === intent.command.action) throw new Error("Submission response lost after durable execution");
      return Response.json({ success: true });
    }
    const key = decodeURIComponent(url.pathname.slice(url.pathname.indexOf("/objects/") + 9));
    if (init?.method === "PUT") {
      const object = (await setup.bucket.put(key, new Uint8Array(await new Response(init.body).arrayBuffer())))!;
      return Response.json({ success: true, result: { key, size: object.size, etag: object.etag, version: object.version } });
    }
    const object = await setup.bucket.get(key);
    return object ? new Response(new Uint8Array(object.bytes), { headers: { ETag: `"${object.etag}"` } }) : new Response(null, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect }));
  return { ...setup, root, messages, requests, loseNextSubmission: (action: ManagementIntent["command"]["action"] = "stage-start") => { loseSubmission = action; }, close: () => {
    fetchSpy.mockRestore();
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  } };
}
const secret = "private-secret";
const show = { kind: "show" as const, show_id: "daily" };

test("default CLI update/publish and compact polling use only Queue/R2, not management HTTP", async () => {
  const setup = await harness();
  try {
    const staged = await updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } });
    expect(staged.phase).toBe("finished");
    expect(staged.async_start?.intent.command.action).toBe("stage-start");
    expect(staged.complete_result?.state).toBe("staged");
    const job = await publishLocalM6Draft(setup.root, setup.config, show, secret);
    expect(job.phase).toBe("async_queued");
    expect(job.claim_receipt).toBeUndefined();
    const status = await readRemoteOperationStatus(setup.root, setup.config, "publication", job.publication.request.job_id, () => secret);
    expect(status.server_status).toMatchObject({ result: "management-status", response: { state: "published" }, authorizes_recovery: false });
    expect(setup.messages.map((intent) => intent.command.action)).toEqual(["stage-start", "upload-complete", "publish"]);
    expect(readLocalDraft(setup.root, setup.config, show).client_state?.phase).toBe("frozen");
    expect(setup.requests.every((url) => new URL(url).hostname === "api.cloudflare.com")).toBe(true);
  } finally { setup.close(); }
});

test("default CLI supports initial Episode and metadata/audio-only revisions with immutable media and GUID", async () => {
  const setup = await harness();
  try {
    const episode = { kind: "episode" as const, show_id: "daily", episode_id: "new" };
    const metadataFile = join(setup.root, "daily", "episode-new.toml"), audioFile = join(setup.root, "clip.mp3");
    const guid = crypto.randomUUID();
    writeFileSync(metadataFile, stringifyToml({ schema_version: 1, episode_id: "new", guid, title: "Test Episode",
      description: "Test description", published_at: "2026-10-15T00:00:00Z" }));
    writeFileSync(audioFile, RSS_IMPORT_AUDIO);
    const update = (selection: { asset: "episode_metadata" } | { asset: "audio"; audio_path: string }) =>
      updateLocalM6Draft(setup.root, setup.config, episode, selection, secret, { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } });
    await update({ asset: "episode_metadata" });
    await update({ asset: "audio", audio_path: audioFile });
    await publishLocalM6Draft(setup.root, setup.config, episode, secret, { audioPath: audioFile });
    const key = "public/episodes/daily/new/metadata.toml";
    const initial = parseEpisodeRevision(setup.text(key));
    writeFileSync(metadataFile, stringifyToml({ ...episodeDraftFromRevision(initial), title: "Changed title" }));
    await update({ asset: "episode_metadata" });
    await publishLocalM6Draft(setup.root, setup.config, episode, secret);
    const changed = parseEpisodeRevision(setup.text(key));
    expect(changed.enclosure_url).toBe(initial.enclosure_url);
    expect(changed.sha256).toBe(initial.sha256);
    expect(changed.guid).toBe(guid);
    expect(await setup.bucket.head(`public/episodes/daily/new/revisions/${initial.revision_id}.toml`)).not.toBeNull();
    writeFileSync(audioFile, Buffer.concat([RSS_IMPORT_AUDIO, Buffer.from([0])]));
    await update({ asset: "audio", audio_path: audioFile });
    await publishLocalM6Draft(setup.root, setup.config, episode, secret, { audioPath: audioFile });
    const audioOnly = parseEpisodeRevision(setup.text(key));
    expect(audioOnly.enclosure_url).not.toBe(initial.enclosure_url);
    expect(audioOnly.guid).toBe(guid);
    expect(audioOnly.published_at).toBe(initial.published_at);
    expect(await setup.bucket.head(`public${new URL(initial.enclosure_url).pathname}`)).not.toBeNull();
  } finally { setup.close(); }
});

test("36 Episode Show update reuses all media and publishes through Queue with no HTTP management", async () => {
  const setup = await harness();
  try {
    const revisions = [];
    for (let index = 0; index < 36; index++) revisions.push((await setup.addEpisode(`episode-${index}`, "active"))!);
    const beforeMedia = setup.writes.filter((key) => key.endsWith(".mp3"));
    await updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } });
    await publishLocalM6Draft(setup.root, setup.config, show, secret);
    expect(setup.writes.filter((key) => key.endsWith(".mp3"))).toEqual(beforeMedia);
    const feed = setup.text("public/podcasts/daily/feed.xml");
    for (const revision of revisions) expect(feed).toContain(revision.guid);
  } finally { setup.close(); }
});

test("lost Queue POST response retains the exact attempted request and never PUTs, resends or falls back", async () => {
  const setup = await harness();
  try {
    setup.loseNextSubmission();
    const update = () => updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } });
    await expect(update()).rejects.toThrow("not acknowledged");
    const draft = readLocalDraft(setup.root, setup.config, show).client_state!;
    const state = readLocalStagingOperation(setup.root, setup.config, draft.uploads[0]!.operation_id).client_state!;
    expect(state.phase).toBe("claim_requested");
    expect(state.async_start?.intent.request_id).toBe(setup.messages[0]!.request_id);
    expect(setup.requests.filter((url) => url.includes("/objects/staging/"))).toHaveLength(0);
    await expect(update()).rejects.toThrow("unresolved upload");
    expect(setup.messages).toHaveLength(1);
  } finally { setup.close(); }
});

test("management waiting is bounded, read-only, and cannot poll after its deadline", async () => {
  const setup = await harness();
  try {
    let now = 0, reads = 0;
    const client = new ManagementQueueClient(setup.config, secret, { reader: { async read(key, maximum) {
      if (key.endsWith("/result.json")) { reads++; now = 11; return null; }
      return setup.reader.read(key, maximum);
    } }, maximumReads: 300, waitMs: 10, now: () => now, delay: async () => { throw new Error("Delay must not extend an expired deadline"); } });
    const submission = await client.prepare({ action: "stage-start", upload: setup.upload });
    await expect(client.wait(submission)).rejects.toThrow("unconfirmed");
    expect(reads).toBe(1);
    expect(setup.messages).toHaveLength(0);
  } finally { setup.close(); }
});

test("lost completion POST retains settlement identity and refuses another upload or publication", async () => {
  const setup = await harness();
  try {
    setup.loseNextSubmission("upload-complete");
    const update = () => updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } });
    await expect(update()).rejects.toThrow("not acknowledged");
    const draft = readLocalDraft(setup.root, setup.config, show).client_state!;
    const stage = readLocalStagingOperation(setup.root, setup.config, draft.uploads[0]!.operation_id).client_state!;
    expect(stage.phase).toBe("settlement_requested");
    expect(stage.async_complete?.intent.command.action).toBe("upload-complete");
    expect(stage.complete_queued).toBeUndefined();
    const status = await readRemoteOperationStatus(setup.root, setup.config, "staging", stage.upload.operation_id, () => secret);
    expect(status.server_status).toMatchObject({ result: "management-status", response: { state: "staged" } });
    await expect(update()).rejects.toThrow("unresolved upload");
    await expect(publishLocalM6Draft(setup.root, setup.config, show, secret)).rejects.toThrow("unresolved upload");
    expect(setup.messages).toHaveLength(2);
  } finally { setup.close(); }
});

test("lost publication POST is inspectable but cannot promote or replay its unknown local journal", async () => {
  const setup = await harness();
  try {
    await updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } });
    setup.loseNextSubmission("publish");
    await expect(publishLocalM6Draft(setup.root, setup.config, show, secret)).rejects.toThrow("not acknowledged");
    const draft = readLocalDraft(setup.root, setup.config, show).client_state!;
    const job = readLocalPublicationJob(setup.root, setup.config, draft.draft_job_id).client_state!;
    expect(job.phase).toBe("async_submit_requested");
    expect(draft.phase).toBe("publication_prepared");
    const status = await readRemoteOperationStatus(setup.root, setup.config, "publication", draft.draft_job_id, () => secret);
    expect(status.server_status).toMatchObject({ result: "management-status", response: { state: "published" } });
    expect(readLocalPublicationJob(setup.root, setup.config, draft.draft_job_id).client_state!.phase).toBe("async_submit_requested");
    await expect(publishLocalM6Draft(setup.root, setup.config, show, secret)).rejects.toThrow("without automatic replay");
    expect(setup.messages).toHaveLength(3);
  } finally { setup.close(); }
});

test("old readiness refuses async operation before any enqueue or upload, with no HTTP fallback", async () => {
  const setup = await harness();
  try {
    const admission = JSON.parse(setup.text("system/lifecycle-service.json"));
    delete admission.runtime_readiness.management_protocol;
    await setup.bucket.put("system/lifecycle-service.json", JSON.stringify(admission));
    await expect(updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" } })).rejects.toThrow("update the Worker first");
    expect(setup.messages).toHaveLength(0);
    expect(readLocalDraft(setup.root, setup.config, show).client_state).toBeNull();
  } finally { setup.close(); }
});

test("a tampered R2 grant cannot start PUTs even after Queue submission was acknowledged", async () => {
  const setup = await harness();
  try {
    const client = new ManagementQueueClient(setup.config, secret, { reader: { async read(key, maximum) {
      const object = await setup.reader.read(key, maximum);
      if (!object || !key.endsWith("/result.json")) return object;
      return { ...object, source: JSON.stringify({ ...JSON.parse(object.source), request_id: crypto.randomUUID() }) };
    } } });
    await expect(updateLocalM6Draft(setup.root, setup.config, show, { asset: "show" }, secret,
      { rest: { accountId: setup.config.account_id, apiToken: "test-rest-token" }, management: client })).rejects.toThrow("authenticated frozen request");
    expect(setup.messages).toHaveLength(1);
    expect(setup.requests.filter((url) => url.includes("/objects/staging/"))).toHaveLength(0);
  } finally { setup.close(); }
});
