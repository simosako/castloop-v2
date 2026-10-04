import { m6ServiceAdminResponseSchema, parseEpisodeDraft, parseEpisodeRevision, parseServiceConfig, parseShowMetadata, stagingAdminResponseSchema, stringifyToml, targetInspectionResponseSchema } from "../../packages/shared/src/index";
import type { EpisodeRevision } from "../../packages/shared/src/index";
import { readLocalDraft } from "../../packages/cli/src/local-draft-journal";
import { validateM6LifecyclePlan } from "../../packages/cli/src/m6-local-lifecycle";
import { readLocalFreshM6Initialization } from "../../packages/cli/src/m6-service-initialization";
import { readLocalM6Update } from "../../packages/cli/src/m6-service-update";
import { readLocalPublicationJob } from "../../packages/cli/src/publication-journal";
import { readLocalStagingOperation } from "../../packages/cli/src/staging-journal";
import { createAcceptanceMp3 } from "./acceptance-audio";
import { digestAcceptanceResponse, expectStandaloneRejection, readAcceptanceBytes, standaloneCommand, standaloneOutput } from "./standalone-harness";
import assert from "node:assert/strict";
import { open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const metadataStaged = process.argv[2] === "--metadata-staged-workspace";
const freshWorkspace = metadataStaged || process.argv[2] === "--fresh-acknowledged-workspace";
if (process.argv.length !== (freshWorkspace ? 4 : 3)) throw new Error("Provide an acknowledged recovery workspace, --fresh-acknowledged-workspace WORKSPACE, or --metadata-staged-workspace WORKSPACE");
const root = resolve(process.argv[freshWorkspace ? 3 : 2]!);
const config = parseServiceConfig(await readFile(join(root, "castloop.toml"), "utf8"));
const previous = JSON.parse(await readFile(join(root, freshWorkspace ? "acceptance.json" : "completion-recovery-acceptance.json"), "utf8")) as {
  result: string; name: string; pause_id: string; worker_version_id?: string; operation_id: string;
};
assert.ok(previous.result === (freshWorkspace ? "fresh_binary_publication_passed" : "completion_recovery_binary_passed") && previous.name === config.worker_name &&
  config.account_id === process.env.CLOUDFLARE_ACCOUNT_ID && config.service_id.startsWith("m6-test-") &&
  [config.worker_name, config.bucket_name, config.queue_name, config.dlq_name].every((name) => name.startsWith("castloop-m6-test-")),
  "Only the acknowledged isolated service is permitted");
const retained = freshWorkspace ? readLocalFreshM6Initialization(root, config) : readLocalM6Update(root, config, previous.operation_id);
assert.ok(retained.state?.phase === (freshWorkspace ? "initialized" : "completed") && !retained.lockPresent &&
  retained.state.request.operation_id === previous.operation_id && retained.state.runtime_readiness);
const workerVersionId = retained.state.runtime_readiness.worker_version_id;
if (!freshWorkspace) assert.equal(workerVersionId, previous.worker_version_id);
const command = (...args: string[]) => standaloneCommand(root, ...args);
const status = async () => m6ServiceAdminResponseSchema.parse(await command("service-status"));
const target = async () => targetInspectionResponseSchema.parse(await command("target-episode", "large", "boundary"));
const jobs: string[] = [];
const cacheHits: string[] = [];
let phase = "preflight";
let readonlyFailures = 0;
let oversizedRejected = false;
let boundaryFixture: { bytes: number; sha256: string } | undefined;
async function waitPublished(job: string, episode: boolean): Promise<EpisodeRevision | null> {
  for (let read = 0; read < 240; read += 1) {
    try {
      const current = episode ? await target() : targetInspectionResponseSchema.parse(await command("target-show", "large"));
      if (!current.unfinished_show_operation && current.show?.lifecycle === "active" &&
        (!episode || current.episode?.lifecycle === "active" && current.current_revision?.revision_id === job) &&
        (await status()).admission.invocations.length === 0) return current.current_revision;
    } catch { readonlyFailures += 1; }
    await Bun.sleep(3000);
  }
  throw new Error("Publication did not settle; retain owner/token without retry or elapsed-time release");
}
async function publish(episode: boolean, audio?: string): Promise<EpisodeRevision | null> {
  const receipt = await command(...(episode ? ["publish-episode", "large", "boundary", ...(audio ? [audio] : [])] : ["publish-show", "large"])) as { result: string; job_id: string };
  assert.equal(receipt.result, "publication-committed");
  jobs.push(receipt.job_id);
  return waitPublished(receipt.job_id, episode);
}
const get = (path: string, method = "GET", headers: Record<string, string> = {}) => fetch(new URL(path, config.public_base_url), {
  method, headers, redirect: "error", signal: AbortSignal.timeout(120000) });
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const object = (key: string) => fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/${config.bucket_name}/objects/${key}`,
  { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
const revision = async (id: string) => parseEpisodeRevision(new TextDecoder().decode(await readAcceptanceBytes(await object(
  `public/episodes/large/boundary/revisions/${id}.toml`))));
async function checkMedia(revision: EpisodeRevision, expected: { bytes: number; sha256: string }): Promise<void> {
  const response = await get(new URL(revision.enclosure_url).pathname);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
  assert.equal(response.headers.get("X-Castloop-Worker-Version"), workerVersionId);
  assert.deepEqual(await digestAcceptanceResponse(response, expected.bytes), expected);
}
async function warmCache(path: string): Promise<void> {
  let previousIds: { inner: string | null; gateway: string | null } | undefined;
  for (let read = 0; read < 12; read += 1) {
    const response = await get(path);
    await readAcceptanceBytes(response);
    const inner = response.headers.get("X-Castloop-Test-Cache-Invocation");
    const gateway = response.headers.get("X-Castloop-Test-Gateway-Invocation");
    assert.ok(inner && gateway);
    if (response.headers.get("X-Castloop-Test-Inner-Cache") === "HIT" && previousIds?.inner === inner) {
      assert.notEqual(gateway, previousIds.gateway, "Default gateway must still execute on an inner cache hit");
      cacheHits.push(path);
      return;
    }
    previousIds = { inner, gateway };
    await Bun.sleep(500);
  }
  throw new Error("Actual named-entrypoint cache hit was not observed");
}

try {
  const before = await status();
  assert.equal(before.worker_version_id, workerVersionId);
  assert.deepEqual(before.admission.runtime_readiness, retained.state.runtime_readiness);
  assert.equal(before.admission.invocations.length, 0);
  const directory = join(root, "large");
  const episodeFile = join(directory, "episode-boundary.toml");
  let original: EpisodeRevision;
  let updated: EpisodeRevision;
  let large: { bytes: number; sha256: string };
  if (metadataStaged) {
    assert.equal(before.admission.state, "open");
    const checkpoint = JSON.parse(await readFile(join(root, "large-media-incomplete.json"), "utf8")) as {
      result: string; phase: string; publication_jobs: string[]; cache_hit_paths: string[];
      oversized_rejected: boolean; boundary_fixture: { bytes: number; sha256: string }; readonly_observation_failures: number;
    };
    assert.equal(checkpoint.result, "large_media_acceptance_incomplete");
    assert.equal(checkpoint.phase, "metadata-only-publication");
    assert.equal(checkpoint.publication_jobs.length, 3);
    assert.equal(new Set(checkpoint.publication_jobs).size, 3);
    assert.equal(checkpoint.oversized_rejected, true);
    for (const id of checkpoint.publication_jobs) {
      const job = readLocalPublicationJob(root, config, id);
      assert.ok(job.client_state?.phase === "committed" && !job.lock_present);
    }
    original = await revision(checkpoint.publication_jobs[1]!);
    updated = await revision(checkpoint.publication_jobs[2]!);
    assert.equal(original.revision_id, checkpoint.publication_jobs[1]);
    assert.equal(updated.revision_id, checkpoint.publication_jobs[2]);
    large = checkpoint.boundary_fixture;
    assert.equal(large.bytes, 300_000_000);
    assert.equal(large.sha256, updated.sha256);
    assert.equal(updated.length_bytes, large.bytes);
    assert.equal(updated.guid, original.guid);
    assert.equal(updated.published_at, original.published_at);
    const current = await target();
    assert.ok(!current.unfinished_show_operation && current.show?.lifecycle === "active" && current.episode?.lifecycle === "active");
    assert.deepEqual(current.current_revision, updated);
    const draft = readLocalDraft(root, config, { kind: "episode", show_id: "large", episode_id: "boundary" });
    assert.ok(draft.client_state?.phase === "editable" && !draft.lock_present && draft.client_state.base_revision_id === updated.revision_id &&
      draft.client_state.uploads.length === 1 && draft.client_state.uploads[0]!.slot === "episode_metadata");
    const publication = readLocalPublicationJob(root, config, draft.client_state.draft_job_id);
    assert.ok(!publication.client_state && !publication.lock_present, "An unknown publication must never be replayed");
    const stageId = draft.client_state.uploads[0]!.operation_id;
    const stage = readLocalStagingOperation(root, config, stageId);
    assert.ok(stage.client_state?.phase === "finished" && stage.client_state.finish_receipt === "staged" && !stage.lock_present &&
      stage.client_state.upload.draft_job_id === draft.client_state.draft_job_id && stage.client_state.upload.payloads.length === 1 &&
      stage.client_state.upload.payloads[0]!.asset === "episode_metadata");
    assert.equal(stage.client_state.upload.expected_show_generation + 1, current.show.generation);
    assert.equal(stage.client_state.upload.expected_episode_generation, current.episode.generation);
    const inspection = await command("operation-status", "staging", stageId) as { server_status: unknown };
    const remote = stagingAdminResponseSchema.parse(inspection.server_status);
    assert.ok(remote.result === "status" && remote.ownership === "released" && !remote.verification_active && !remote.draft_committed &&
      remote.progress?.outcome === "staged");
    assert.deepEqual(remote.upload, stage.client_state.upload);
    assert.deepEqual(remote.progress.readback_receipts, stage.client_state.readback_receipts);
    assert.deepEqual(checkpoint.cache_hit_paths, ["/podcasts/large/feed.xml", "/podcasts/large/cover.png", new URL(original.enclosure_url).pathname]);
    jobs.push(...checkpoint.publication_jobs);
    cacheHits.push(...checkpoint.cache_hit_paths);
    oversizedRejected = true;
    boundaryFixture = large;
    readonlyFailures = checkpoint.readonly_observation_failures;
    await writeFile(join(root, "large-media-continuation-before.json"), JSON.stringify({ name: config.worker_name,
      worker_version_id: workerVersionId, draft_job_id: draft.client_state.draft_job_id, staged_operation_id: stageId,
      checkpoint: "finished-metadata-staging" }), { mode: 0o600, flag: "wx" });
  } else {
    assert.equal(before.admission.state, "paused");
    assert.equal(before.admission.pause_id, previous.pause_id);
    const missing = targetInspectionResponseSchema.parse(await command("target-show", "large"));
    assert.equal(missing.show, null);
    await writeFile(join(root, "large-media-before.json"), JSON.stringify({ name: config.worker_name, maximum_bytes: 300_000_000,
      planned_show: "large", planned_episode: "boundary" }), { mode: 0o600, flag: "wx" });
    phase = "explicit-resume";
    await command("service-resume", previous.pause_id);
    phase = "new-show";
    await standaloneOutput(root, "create-show", "large", "https://example.org/castloop-m6-large-media-test");
    const showFile = join(directory, "show.toml");
    const show = parseShowMetadata(await readFile(showFile, "utf8"));
    const cover = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nxsAAAAASUVORK5CYII=", "base64");
    await writeFile(join(directory, "cover.png"), cover, { mode: 0o600, flag: "wx" });
    await writeFile(showFile, stringifyToml({ ...show, image_path: "cover.png" }));
    await command("update-show", "large");
    await publish(false);
    phase = "small-original-publication";
    await standaloneOutput(root, "create-episode", "large", "boundary");
    const episode = parseEpisodeDraft(await readFile(episodeFile, "utf8"));
    const smallFile = join(directory, "small.mp3");
    const small = await createAcceptanceMp3(smallFile, 50);
    await command("update-episode", "large", "boundary");
    await command("update-episode-audio", "large", "boundary", smallFile);
    const first = await publish(true, smallFile);
    assert.ok(first);
    original = first;
    await checkMedia(original, small);
    const retryRejection = await expectStandaloneRejection(root, "publication-retry", original.revision_id);
    assert.ok(retryRejection.includes("unfinished held owner"), "A completed publication cannot be requeued");
    phase = "actual-cache-hits";
    for (const path of ["/podcasts/large/feed.xml", "/podcasts/large/cover.png", new URL(original.enclosure_url).pathname]) await warmCache(path);
    phase = "oversized-local-rejection";
    const oversizedFile = join(directory, "oversized.mp3");
    const oversized = await open(oversizedFile, "wx", 0o600);
    try { await oversized.truncate(300_000_001); await oversized.sync(); } finally { await oversized.close(); }
    const targetBefore = await target();
    const rejection = await expectStandaloneRejection(root, "update-episode-audio", "large", "boundary", oversizedFile);
    assert.ok(rejection.includes("300000000") || rejection.includes("300,000,000"), "Rejection must identify the local size limit");
    assert.deepEqual(await target(), targetBefore);
    assert.equal((await status()).admission.invocations.length, 0);
    oversizedRejected = true;
    phase = "boundary-fixture";
    const largeFile = join(directory, "boundary.mp3");
    large = await createAcceptanceMp3(largeFile, 719424, 182);
    assert.equal(large.bytes, 300_000_000);
    boundaryFixture = large;
    phase = "boundary-audio-staging";
    console.log(JSON.stringify({ phase, bytes: large.bytes, result: "starting" }));
    await command("update-episode-audio", "large", "boundary", largeFile);
    phase = "boundary-audio-publication";
    const boundary = await publish(true, largeFile);
    assert.ok(boundary);
    updated = boundary;
    assert.equal(updated.length_bytes, large.bytes);
    assert.equal(updated.sha256, large.sha256);
    assert.equal(updated.guid, episode.guid);
    assert.equal(updated.published_at, episode.published_at);
    assert.notEqual(updated.enclosure_url, original.enclosure_url);
    await checkMedia(updated, large);
    await checkMedia(original, small);
    console.log(JSON.stringify({ phase, bytes: large.bytes, result: "published" }));
    phase = "metadata-only-publication";
    await writeFile(episodeFile, stringifyToml({ ...episode, title: "M6 exact 300 MB metadata revision" }));
    await command("update-episode", "large", "boundary");
  }
  phase = "metadata-only-publication";
  const episode = parseEpisodeDraft(await readFile(episodeFile, "utf8"));
  const metadata = await publish(true);
  assert.ok(metadata);
  assert.equal(metadata.guid, episode.guid);
  assert.equal(metadata.published_at, episode.published_at);
  assert.equal(metadata.enclosure_url, updated.enclosure_url);
  assert.equal(metadata.sha256, large.sha256);
  assert.equal(metadata.length_bytes, large.bytes);
  for (const revision of [original, updated, metadata]) assert.ok((await readAcceptanceBytes(await object(
    `public/episodes/large/boundary/revisions/${revision.revision_id}.toml`))).length > 0);
  const path = new URL(updated.enclosure_url).pathname;
  const head = await get(path, "HEAD");
  await head.body?.cancel();
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(large.bytes));
  const tail = await get(path, "GET", { Range: "bytes=-10" });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("Content-Range"), "bytes 299999990-299999999/300000000");
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), new Uint8Array(10));
  const conditional = await get(path, "GET", { "If-None-Match": head.headers.get("ETag")! });
  await conditional.body?.cancel();
  assert.equal(conditional.status, 304);
  phase = "explicit-payload-delete";
  const plan = validateM6LifecyclePlan(config, await command("preview-show-lifecycle", "large", "delete"));
  assert.ok(plan.preview.eligible);
  const planFile = join(root, `large-media-delete-${plan.request.job_id}.json`);
  await writeFile(planFile, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
  await command("lifecycle-execute", planFile, plan.preview.request_sha256, "confirm-delete-retain-records");
  let deleted = false;
  for (let read = 0; read < 240; read += 1) {
    try {
      const current = await target();
      if (current.show?.lifecycle === "deleted" && !current.unfinished_show_operation && (await status()).admission.invocations.length === 0) {
        deleted = true; break;
      }
    } catch { readonlyFailures += 1; }
    await Bun.sleep(3000);
  }
  assert.ok(deleted, "Explicit deletion remains unfinished; retain ownership");
  for (const revision of [original, updated]) {
    const key = `public${new URL(revision.enclosure_url).pathname}`;
    const response = await object(key);
    await response.body?.cancel();
    assert.equal(response.status, 404);
    const publicResponse = await get(new URL(revision.enclosure_url).pathname);
    await publicResponse.body?.cancel();
    assert.equal(publicResponse.status, 410);
  }
  phase = "explicit-pause";
  const pauseId = crypto.randomUUID();
  await command("service-pause", pauseId);
  assert.equal((await status()).admission.invocations.length, 0);
  await writeFile(join(root, "large-media-acceptance.json"), JSON.stringify({ result: "large_media_binary_acceptance_passed", name: config.worker_name,
    worker_version_id: workerVersionId, maximum_audio: large, oversized_rejected: true, guid_date_history_preserved: true,
    audio_only_and_metadata_only_verified: true, get_head_suffix_range_conditional_verified: true, cache_hit_paths: cacheHits, publication_jobs: jobs,
    deletion_job: plan.request.job_id, pause_id: pauseId, payloads_deleted: true, resources_retained_paused: true,
    readonly_observation_failures: readonlyFailures, continuation_checkpoint: metadataStaged ? "finished-metadata-staging" : "none",
    authorizes_release: false }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ result: "large_media_binary_acceptance_passed", workspace: root, resources_retained_paused: true }));
} catch {
  await writeFile(join(root, metadataStaged ? "large-media-continuation-incomplete.json" : "large-media-incomplete.json"), JSON.stringify({ result: "large_media_acceptance_incomplete", phase, publication_jobs: jobs,
    cache_hit_paths: cacheHits, oversized_rejected: oversizedRejected, boundary_fixture: boundaryFixture,
    readonly_observation_failures: readonlyFailures, resources_not_deleted: true, authorizes_recovery: false }, null, 2), { mode: 0o600, flag: "wx" });
  console.error(`Large media acceptance did not complete (${phase}); preserve journals, streams and owners without replay or automatic release.`);
  process.exitCode = 1;
}
