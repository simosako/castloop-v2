import { expect, test } from "bun:test";
import { episodeDraftFromRevision, parseEpisodeDraft, parseShowMetadata, publicationAdminRequestSchema, publicationRequestSchema, stagePayloadKey, stringifyToml } from "@castloop/shared";
import { readShowControl } from "../../../src/lifecycle-control";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { handleM6PublicationAdmin } from "../../../src/publication-admin";
import { queueM6Candidate } from "../../../src/m6-routes";
import { publicationAdminFixture } from "../../../src/test-support/publication-admin";
import { PublicationAdminClient } from "./publication-client";
import { createPublicationJournal } from "./publication-journal";
import { inspectPublicationOperation, runPublicationClaim, runPublicationCommit, runPublicationRetry } from "./publication-operation";
import { createLocalPublicationEffects } from "./publication-sources";
import type { LocalPublicationInputs } from "./publication-sources";
import { StagingAdminClient, stagingClientOperation, stagingClientTargets } from "./staging-client";
import { createStagingJournal, validateStagingClientState } from "./staging-journal";
import { runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import { createStagingRestEffects } from "./staging-rest-operation";
import type { StagingRestTransport } from "./staging-rest";
import { freezeStagingSources } from "./staging-sources";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function fixture(mode: "show" | "episode" | "metadata" | "audio" = "show") {
  const setup = await publicationAdminFixture(mode);
  const root = await mkdtemp("/tmp/opencode/castloop-publication-sources-");
  const journal = createPublicationJournal(root, setup.config, setup.frozen);
  const stages = setup.stages.map((upload) => validateStagingClientState({ schema_version: 1, identity: journal.load().identity, upload,
    phase: "finished", claim_receipt: stagingClientOperation(upload), begin_receipt: stagingClientTargets(upload),
    acknowledged_puts: upload.payloads.length, put_outcome: "staged", finish_receipt: "staged" }));
  const metadataPath = join(root, mode === "show" ? "show.toml" : "episode.toml");
  const local: LocalPublicationInputs = { stages, metadataPath, ...(setup.base ? { baseRevision: setup.base } : {}) };
  if (mode === "audio") await writeFile(metadataPath, stringifyToml(episodeDraftFromRevision(setup.base!)));
  for (const stage of stages) for (const payload of stage.upload.payloads) {
    const object = await setup.bucket.get(stagePayloadKey(stage.upload, payload.asset));
    const bytes = object!.bytes;
    if (payload.asset.endsWith("metadata")) await writeFile(metadataPath, bytes);
    else if (payload.asset === "audio") { local.audioPath = join(root, "audio.mp3"); await writeFile(local.audioPath, bytes); }
    else {
      local.coverPath = join(root, parseShowMetadata(setup.text(stagePayloadKey(stage.upload, "show_metadata"))).image_path);
      await writeFile(local.coverPath, bytes);
    }
  }
  const calls: string[] = [];
  const client = new PublicationAdminClient(setup.config, "private-secret", async (input, init) => {
    const request = new Request(input, init);
    calls.push(publicationAdminRequestSchema.parse(await request.clone().json()).action);
    return (await handleM6PublicationAdmin(request, setup.env, setup.bindings))!;
  });
  const effects = createLocalPublicationEffects(setup.config, journal.load(), "private-secret", local, client);
  const consume = (key: string) => queueM6Candidate({ queue: setup.config.queue_name,
    messages: [{ id: "publication", body: { object: { key } } }] } as never, setup.candidateEnv, setup.cachedAssets);
  return { ...setup, root, journal, stages, local, calls, client, effects, consume };
}

for (const mode of ["show", "episode", "metadata", "audio"] as const) {
  test(`latest local ${mode} inputs bind acknowledged staging journals and complete explicitly`, async () => {
    const setup = await fixture(mode);
    const original = await readFile(setup.local.metadataPath);
    await runPublicationClaim(setup.journal, setup.effects);
    await runPublicationCommit(setup.journal, setup.effects);
    await setup.consume(setup.markerKey);
    expect((await inspectPublicationOperation(setup.journal, setup.effects)).server_status.status?.state).toBe("published");
    expect(await readFile(setup.local.metadataPath)).toEqual(original);
    const journal = JSON.stringify(setup.journal.load());
    expect(journal).not.toContain(setup.local.metadataPath);
    expect(journal).not.toContain("private-secret");
    expect(journal).not.toContain("Private Episode description");
    expect(setup.calls).toEqual(["claim", "status", "commit", "status"]);
  });
}

for (const mode of ["show", "episode", "metadata", "audio"] as const) {
  test(`unstaged local ${mode} metadata edit blocks claim and commit without consuming POST phase`, async () => {
    const setup = await fixture(mode);
    const original = await readFile(setup.local.metadataPath, "utf8");
    const changed = stringifyToml({ ...(mode === "show" ? parseShowMetadata(original) : parseEpisodeDraft(original)), title: "Unstaged private edit" });
    await writeFile(setup.local.metadataPath, changed);
    await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow();
    expect(setup.journal.load().phase).toBe("prepared");
    expect(setup.calls).toEqual([]);
    await writeFile(setup.local.metadataPath, original);
    await runPublicationClaim(setup.journal, setup.effects);
    await writeFile(setup.local.metadataPath, changed);
    await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow();
    expect(setup.journal.load().phase).toBe("claimed");
    expect(setup.calls).toEqual(["claim", "status"]);
    expect(await setup.bucket.head(setup.markerKey)).toBeNull();
    await writeFile(setup.local.metadataPath, original);
    await runPublicationCommit(setup.journal, setup.effects);
    expect(setup.journal.load().phase).toBe("committed");
  });
}

test("same-size audio/cover edits and missing files block publication before a modifying POST", async () => {
  for (const mode of ["show", "episode", "audio"] as const) {
    const setup = await fixture(mode);
    const path = setup.local.audioPath ?? setup.local.coverPath!;
    const original = await readFile(path);
    await writeFile(path, new Uint8Array(original.length));
    await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow("checksum");
    expect(setup.journal.load().phase).toBe("prepared");
    expect(setup.calls).toEqual([]);
    await writeFile(path, original);
    const effects = createLocalPublicationEffects(setup.config, setup.journal.load(), "private-secret", {
      ...setup.local, metadataPath: join(setup.root, "missing.toml") }, setup.client);
    await expect(runPublicationClaim(setup.journal, effects)).rejects.toThrow();
    expect(setup.calls).toEqual([]);
  }
});

test("audio-only unchanged metadata permits equivalent TOML but rejects all unstaged semantic changes", async () => {
  const setup = await fixture("audio");
  const original = await readFile(setup.local.metadataPath, "utf8");
  await writeFile(setup.local.metadataPath, `# Local comment\n${original}\n`);
  await setup.effects.checkLocalInputs!();
  const base = episodeDraftFromRevision(setup.base!);
  for (const draft of [{ ...base, title: "Unstaged" }, { ...base, guid: crypto.randomUUID() },
    { ...base, published_at: "2026-10-01T12:00:00Z" }, { ...base, episode_id: "foreign" }, { ...base, explicit: true }]) {
    await writeFile(setup.local.metadataPath, stringifyToml(draft));
    await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow("explicitly stage");
    expect(setup.journal.load().phase).toBe("prepared");
  }
  expect(setup.calls).toEqual([]);
});

test("source evidence cannot reuse foreign, unfinished, aborted, duplicated, changed or newer stage journals", async () => {
  const setup = await fixture();
  const first = setup.stages[0]!;
  const cases = [[], [first, first], [{ ...first, identity: { ...first.identity, account_id: "f".repeat(32) } }],
    [{ ...first, upload: { ...first.upload, draft_job_id: crypto.randomUUID() }, begin_receipt: undefined }],
    [{ ...first, phase: "finish_requested", finish_receipt: undefined }],
    [{ ...first, put_outcome: "aborted", acknowledged_puts: 0, finish_receipt: "aborted", reason_code: "put_failed" }],
    [{ ...first, upload: { ...first.upload, expected_show_generation: setup.frozen.request.expected_show_generation } }],
    [{ ...first, upload: { ...first.upload, payloads: first.upload.payloads.map((payload) => ({ ...payload, sha256: "0".repeat(64) })) } }],
  ];
  for (const stages of cases) expect(() => createLocalPublicationEffects(setup.config, setup.journal.load(), "private-secret", {
    ...setup.local, stages: stages as never }, setup.client)).toThrow();
  expect(setup.calls).toEqual([]);
});

test("base snapshot and exact changed-source set are checked before local IO/API", async () => {
  const setup = await fixture("audio");
  for (const local of [{ ...setup.local, baseRevision: undefined },
    { ...setup.local, baseRevision: { ...setup.base!, revision_id: crypto.randomUUID() } },
    { ...setup.local, baseRevision: { ...setup.base!, episode_id: "foreign" } },
    { ...setup.local, audioPath: undefined }, { ...setup.local, coverPath: "foreign.png" }]) {
    expect(() => createLocalPublicationEffects(setup.config, setup.journal.load(), "private-secret", local, setup.client)).toThrow();
  }
  const metadata = await fixture("metadata");
  expect(() => createLocalPublicationEffects(metadata.config, metadata.journal.load(), "private-secret", {
    ...metadata.local, audioPath: "unstaged.mp3" }, metadata.client)).toThrow("changed assets exactly");
  expect(setup.calls).toEqual([]);
});

test("local metadata is bounded/strict/no-follow and cover path must follow Show TOML", async () => {
  const setup = await fixture();
  const link = join(setup.root, "link.toml");
  await symlink(setup.local.metadataPath, link);
  const effects = createLocalPublicationEffects(setup.config, setup.journal.load(), "private-secret", { ...setup.local, metadataPath: link }, setup.client);
  await expect(runPublicationClaim(setup.journal, effects)).rejects.toThrow();
  await writeFile(setup.local.metadataPath, "x".repeat(1000001));
  await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow("size/type");
  expect(setup.calls).toEqual([]);
  const fresh = await fixture();
  const foreignCover = createLocalPublicationEffects(fresh.config, fresh.journal.load(), "private-secret", {
    ...fresh.local, coverPath: join(fresh.root, "foreign.jpg") }, fresh.client);
  await expect(runPublicationClaim(fresh.journal, foreignCover)).rejects.toThrow("cover source");
  expect(fresh.calls).toEqual([]);
});

test("committed job retry/status never require editable originals or silently publish their later changes", async () => {
  const setup = await fixture("episode");
  await runPublicationClaim(setup.journal, setup.effects);
  await runPublicationCommit(setup.journal, setup.effects);
  const marker = setup.text(setup.markerKey);
  await writeFile(setup.local.metadataPath, "invalid and changed local metadata");
  await writeFile(setup.local.audioPath!, new Uint8Array([0]));
  await inspectPublicationOperation(setup.journal, setup.effects);
  await runPublicationRetry(setup.journal, setup.effects);
  expect(setup.text(setup.markerKey)).toBe(marker);
  expect(setup.sent).toEqual([setup.markerKey]);
  await setup.consume(setup.sent[0]!);
  expect((await inspectPublicationOperation(setup.journal, setup.effects)).server_status.status?.state).toBe("published");
});

test("real local staging journal and REST/source effects feed guarded publication through the M6 Queue", async () => {
  const setup = await stagingAdminFixture("show");
  const root = await mkdtemp("/tmp/opencode/castloop-local-pipeline-");
  const metadataPath = join(root, "show.toml");
  const coverPath = join(root, parseShowMetadata(new TextDecoder().decode(setup.contents[0]!.bytes)).image_path);
  await writeFile(metadataPath, setup.contents[0]!.bytes);
  await writeFile(coverPath, setup.contents[1]!.bytes);
  const sources = await freezeStagingSources(root, setup.upload, [metadataPath, coverPath]);
  const stageJournal = createStagingJournal(root, setup.config, setup.upload);
  const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) =>
    (await handleM6StagingAdmin(new Request(input, init), setup.env, setup.bindings))!);
  const transport: StagingRestTransport = async (input, init) => {
    const key = new URL(String(input)).pathname.split("/objects/")[1]!;
    if (init?.method === "PUT") {
      const bytes = new Uint8Array(await new Request(input, init).arrayBuffer());
      const object = (await setup.bucket.put(key, bytes))!;
      return Response.json({ success: true, result: { key, size: object.size, etag: object.etag, version: object.version } });
    }
    const object = (await setup.bucket.get(key))!;
    return new Response(object.bytes, { headers: { ETag: `"${object.etag}"` } });
  };
  const stageEffects = createStagingRestEffects(setup.config, stageJournal.load(), "private-secret", sources,
    { accountId: setup.config.account_id, apiToken: "private-token", transport }, client);
  try {
    await runStagingClaim(stageJournal, stageEffects);
    await runStagingBeginAndUpload(stageJournal, stageEffects);
    await runStagingSettle(stageJournal, stageEffects, { put_requests_settled: true, no_more_puts: true });
    await runStagingFinish(stageJournal, stageEffects);
    const frozen = publicationRequestSchema.parse({ schema_version: 1, request: { schema_version: 1, job_id: setup.upload.draft_job_id,
      show_id: "daily", kind: "show", action: "publish", expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      created_at: "2026-10-02T12:00:00Z" }, commit: { schema_version: 1, kind: "show", show_id: "daily", job_id: setup.upload.draft_job_id,
      metadata_sha256: setup.upload.payloads[0]!.sha256, cover_sha256: setup.upload.payloads[1]!.sha256, cover_extension: "jpg" },
      staged_uploads: [setup.upload.operation_id] });
    const journal = createPublicationJournal(root, setup.config, frozen);
    const env = { ...setup.env, CASTLOOP_QUEUE: { send: async () => {} } };
    const publicationClient = new PublicationAdminClient(setup.config, "private-secret", async (input, init) =>
      (await handleM6PublicationAdmin(new Request(input, init), env, setup.bindings))!);
    const effects = createLocalPublicationEffects(setup.config, journal.load(), "private-secret", {
      stages: [stageJournal.load()], metadataPath, coverPath }, publicationClient);
    await runPublicationClaim(journal, effects);
    await runPublicationCommit(journal, effects);
    const key = journal.load().commit_receipt!.key;
    const cachedAssets = Object.assign(() => ({ fetch: async () => new Response() }), {
      ...setup.bindings.cachedAssets, invalidate: async () => {} });
    await queueM6Candidate({ queue: setup.config.queue_name, messages: [{ id: "show", body: { object: { key } } }] } as never,
      { ...env, CASTLOOP_BUCKET: setup.bucket as never, CASTLOOP_QUEUE: env.CASTLOOP_QUEUE as never,
        CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" }, CASTLOOP_DLQ_NAME: setup.config.dlq_name },
      cachedAssets);
    expect((await inspectPublicationOperation(journal, effects)).server_status.status?.state).toBe("published");
    expect(stageJournal.load().phase).toBe("finished");
    expect(await readFile(metadataPath)).toEqual(Buffer.from(setup.contents[0]!.bytes));
  } finally { await sources.dispose(); }
});
