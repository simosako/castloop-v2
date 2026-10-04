import { lifecycleAdminResponseSchema, m6ServiceAdminResponseSchema, parseServiceConfig, targetInspectionResponseSchema } from "../../packages/shared/src/index";
import type { LifecycleOperationRequest } from "../../packages/shared/src/index";
import { readLocalM6Update } from "../../packages/cli/src/m6-service-update";
import { validateM6LifecyclePlan } from "../../packages/cli/src/m6-local-lifecycle";
import { classifyLifecycleDeletionKey } from "../../src/lifecycle-deletion";
import { readAcceptanceBytes as bytes, standaloneCommand } from "./standalone-harness";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.argv.length !== 3) throw new Error("Provide the explicitly acknowledged compatible-update workspace");
const root = resolve(process.argv[2]!);
const config = parseServiceConfig(await readFile(join(root, "castloop.toml"), "utf8"));
const acceptance = JSON.parse(await readFile(join(root, "compatible-update-acceptance.json"), "utf8")) as {
  result: string; name: string; operation_id: string; pause_id: string; runtime_readiness: { worker_version_id: string };
};
const retained = readLocalM6Update(root, config, acceptance.operation_id);
assert.ok(acceptance.result === "compatible_binary_update_passed" && acceptance.name === config.worker_name &&
  config.account_id === process.env.CLOUDFLARE_ACCOUNT_ID && config.service_id.startsWith("m6-test-") &&
  [config.worker_name, config.bucket_name, config.queue_name, config.dlq_name].every((name) => name.startsWith("castloop-m6-test-")) &&
  retained.state?.phase === "completed" && !retained.lockPresent, "Only the acknowledged isolated service is permitted");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const base = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/${config.bucket_name}/objects`;
const observations: Array<{ kind: string; action: string; job_id: string }> = [];
let phase = "preflight";
let readonlyFailures = 0;

const command = (...args: string[]) => standaloneCommand(root, ...args);
const status = async () => m6ServiceAdminResponseSchema.parse(await command("service-status"));
const target = async () => targetInspectionResponseSchema.parse(await command("target-episode", "fresh", "first"));
const hash = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const object = (key: string) => fetch(`${base}/${key}`, { headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
  redirect: "error", signal: AbortSignal.timeout(30000) });
const get = (path: string, method = "GET", headers: Record<string, string> = {}) => fetch(new URL(path, config.public_base_url), {
  method, headers, redirect: "error", signal: AbortSignal.timeout(30000) });
async function inventory(): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of ["public/podcasts/fresh/", "public/episodes/fresh/", "staging/shows/fresh/", "staging/episodes/fresh/"]) {
    const response = await fetch(`${base}?prefix=${encodeURIComponent(prefix)}&limit=100`, { headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(30000) });
    const value = JSON.parse(new TextDecoder().decode(await bytes(response))) as { success: boolean; result: Array<{ key: string }> };
    assert.ok(value.success && Array.isArray(value.result) && value.result.length < 100 && !response.headers.get("cf-r2-cursor"),
      "Only a bounded complete small-fixture inventory is accepted");
    for (const entry of value.result) { assert.ok(entry.key.startsWith(prefix)); keys.push(entry.key); }
  }
  assert.equal(new Set(keys).size, keys.length);
  return keys.sort();
}
async function absent(key: string): Promise<void> {
  const response = await object(key);
  await response.body?.cancel();
  assert.equal(response.status, 404, "Deleted payload must be physically absent in private R2");
}
async function hidden(paths: string[], code: 404 | 410, etags: Map<string, string>): Promise<void> {
  for (const path of paths) {
    for (const [method, headers] of [["GET", {}], ["HEAD", {}], ["GET", { Range: "bytes=0-9" }],
      ["GET", { "If-None-Match": etags.get(path)! }]] as Array<[string, Record<string, string>]>) {
      const response = await get(`${path}?lifecycle-check=1`, method, headers);
      await response.body?.cancel();
      assert.equal(response.status, code, "Warm public data must not bypass lifecycle visibility");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  }
}
async function settled(): Promise<void> {
  for (let read = 0; read < 180; read += 1) {
    try {
      if (!(await target()).unfinished_show_operation && (await status()).admission.invocations.length === 0) return;
    } catch { readonlyFailures += 1; }
    await Bun.sleep(3000);
  }
  throw new Error("Owner or invocation remains unfinished; elapsed time does not authorize release");
}
async function lifecycle(kind: "show" | "episode", action: LifecycleOperationRequest["action"]): Promise<void> {
  phase = `${kind}-${action}`;
  console.log(JSON.stringify({ phase, result: "starting" }));
  const args = kind === "show" ? ["preview-show-lifecycle", "fresh", action] : ["preview-episode-lifecycle", "fresh", "first", action];
  const plan = validateM6LifecyclePlan(config, await command(...args));
  assert.ok(plan.preview.eligible);
  const file = join(root, `lifecycle-plan-${plan.request.job_id}.json`);
  await writeFile(file, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
  const receipt = await command("lifecycle-execute", file, plan.preview.request_sha256,
    action === "delete" ? "confirm-delete-retain-records" : "confirm") as { result: string; job_id: string };
  assert.equal(receipt.result, "lifecycle-committed");
  assert.equal(receipt.job_id, plan.request.job_id);
  observations.push({ kind, action, job_id: receipt.job_id });
  let completed = false;
  for (let read = 0; read < 180; read += 1) {
    let remote;
    try { remote = await command("operation-status", "lifecycle", receipt.job_id) as { server_status: unknown }; }
    catch { readonlyFailures += 1; await Bun.sleep(3000); continue; }
    const result = lifecycleAdminResponseSchema.parse(remote.server_status);
    assert.equal(result.result, "status");
    if (result.result !== "status") throw new Error("Unexpected lifecycle status");
    assert.notEqual(result.status?.state, "failed", "Consumer failure requires explicit diagnosis, not automatic retry");
    if (result.status?.state === "completed" && result.ownership === "released" && !result.execution_active) {
      assert.ok(result.progress?.purge_confirmed && result.progress.phase === "finished" && result.marker_present);
      completed = true;
      break;
    }
    await Bun.sleep(3000);
  }
  assert.ok(completed, "Unfinished lifecycle owner must remain retained");
  await settled();
  const expected = action === "unpublish" ? "unpublished" : action === "restore" ? "active" : "deleted";
  const current = await target();
  assert.equal(kind === "show" ? current.show?.lifecycle : current.episode?.lifecycle, expected);
  console.log(JSON.stringify({ phase, result: "completed", job_id: receipt.job_id }));
}

try {
  const before = await status();
  assert.equal(before.admission.state, "paused");
  assert.equal(before.admission.pause_id, acceptance.pause_id);
  assert.equal(before.worker_version_id, acceptance.runtime_readiness.worker_version_id);
  assert.equal(before.admission.invocations.length, 0);
  const original = await target();
  assert.equal(original.unfinished_show_operation, false);
  assert.equal(original.episode?.lifecycle, "active");
  const revision = original.current_revision;
  assert.ok(revision && revision.length_bytes < 2_000_000);
  const keys = await inventory();
  assert.ok(keys.length > 0);
  const fixedKeys = [`public/episodes/fresh/first/metadata.toml`, `public/episodes/fresh/first/revisions/${revision.revision_id}.toml`,
    `public/podcasts/fresh/episodes/first/${revision.revision_id}.mp3`];
  const fixed = await Promise.all(fixedKeys.map(async (key) => ({ key, sha256: hash(await bytes(await object(key))) })));
  await writeFile(join(root, "lifecycle-before.json"), JSON.stringify({ name: config.worker_name, keys, fixed }, null, 2), { mode: 0o600, flag: "wx" });
  phase = "explicit-resume";
  await command("service-resume", acceptance.pause_id);
  const feedPath = "/podcasts/fresh/feed.xml";
  const coverPath = "/podcasts/fresh/cover.png";
  const mediaPath = new URL(revision.enclosure_url).pathname;
  const paths = [feedPath, coverPath, mediaPath];
  const etags = new Map<string, string>();
  phase = "warm-delivery";
  for (const path of paths) {
    for (let read = 0; read < 2; read += 1) {
      const response = await get(path);
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
      assert.equal(response.headers.get("X-Castloop-Worker-Version"), before.worker_version_id);
      assert.ok((await bytes(response)).length > 0);
      assert.ok(response.headers.get("ETag"));
      etags.set(path, response.headers.get("ETag")!);
    }
    const head = await get(path, "HEAD");
    await head.body?.cancel();
    assert.equal(head.status, 200);
    const conditional = await get(path, "GET", { "If-None-Match": etags.get(path)! });
    await conditional.body?.cancel();
    assert.equal(conditional.status, 304);
  }
  const range = await get(mediaPath, "GET", { Range: "bytes=0-9" });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
  const invalid = await get(mediaPath, "GET", { Range: `bytes=${revision.length_bytes}-` });
  await invalid.body?.cancel();
  assert.equal(invalid.status, 416);
  await lifecycle("episode", "unpublish");
  await hidden([mediaPath], 404, etags);
  assert.ok(!new TextDecoder().decode(await bytes(await get(feedPath))).includes(revision.guid));
  await lifecycle("episode", "restore");
  assert.deepEqual((await target()).current_revision, revision);
  await lifecycle("show", "unpublish");
  await hidden(paths, 404, etags);
  await lifecycle("show", "restore");
  assert.deepEqual((await target()).current_revision, revision);
  assert.ok(new TextDecoder().decode(await bytes(await get(feedPath))).includes(revision.guid));
  for (const expected of fixed) assert.equal(hash(await bytes(await object(expected.key))), expected.sha256);
  await lifecycle("episode", "delete");
  await hidden([mediaPath], 410, etags);
  assert.ok(!new TextDecoder().decode(await bytes(await get(feedPath))).includes(revision.guid));
  const episodeTarget = { kind: "episode" as const, showId: "fresh", episodeId: "first" };
  for (const key of keys.filter((key) => classifyLifecycleDeletionKey(episodeTarget, key) === "payload")) await absent(key);
  assert.ok((await inventory()).filter((key) => classifyLifecycleDeletionKey(episodeTarget, key) === "payload").length === 0);
  await lifecycle("show", "delete");
  await hidden(paths, 410, etags);
  await absent("system/shows/fresh/show.toml");
  assert.ok((await inventory()).every((key) => classifyLifecycleDeletionKey({ kind: "show", showId: "fresh" }, key) === "marker"));
  for (const key of ["system/show-publications/fresh.json", "system/show-reservations/fresh.json", "system/episode-lifecycle/fresh/first.toml"]) {
    assert.ok((await bytes(await object(key))).length > 0);
  }
  for (const observation of observations) {
    for (const name of ["request.toml", "status.toml", "progress.toml"]) assert.ok((await bytes(await object(`system/jobs/${observation.job_id}/${name}`))).length > 0);
    const prefix = observation.kind === "show" ? "shows/fresh" : "episodes/fresh/first";
    assert.ok((await bytes(await object(`staging/lifecycle/${prefix}/${observation.job_id}/commit.json`))).length > 0);
  }
  phase = "explicit-pause";
  const pauseId = crypto.randomUUID();
  await command("service-pause", pauseId);
  assert.equal((await status()).admission.invocations.length, 0);
  await writeFile(join(root, "lifecycle-acceptance.json"), JSON.stringify({ result: "lifecycle_binary_acceptance_passed", name: config.worker_name,
    worker_version_id: before.worker_version_id, observations, pause_id: pauseId, permanent_records_retained: true, known_payloads_deleted: true,
    guid_revision_preserved_on_restore: true, get_head_range_conditional_visibility_verified: true, cache_hit_proven: false,
    readonly_observation_failures: readonlyFailures, resources_retained_paused: true, authorizes_release: false }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ result: "lifecycle_binary_acceptance_passed", workspace: root, resources_retained_paused: true }));
} catch {
  await writeFile(join(root, "lifecycle-incomplete.json"), JSON.stringify({ result: "lifecycle_acceptance_incomplete", phase, observations,
    readonly_observation_failures: readonlyFailures, authorizes_recovery: false, resources_not_deleted: true }, null, 2), { mode: 0o600, flag: "wx" });
  console.error(`Lifecycle acceptance did not complete (${phase}); preserve journals and owners without mutation replay or automatic resume.`);
  process.exitCode = 1;
}
