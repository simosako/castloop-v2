import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildM6WorkerUploadMetadata, parseShowControl, serviceAdmissionSchema,
  workerDeploymentsSnapshotSchema, workerSettingsSnapshotSchema, workerVersionsSnapshotSchema,
  workerVersionSnapshotSchema } from "../build/castloop-v2-rss-a8c7e54/packages/shared/src/index";

const root = "[LOCAL_TEST_ROOT]";
const evidence = join(root, "evidence/rss-performance-a8c7e54/update-investigation");
const workspace = join(root, "workspaces/rss-20261012-run1");
const operation = "3ad4f8af-7552-40a2-9525-8bf434a6146e";
const journalPath = join(workspace, ".castloop/service-updates/rsstest-1012-r1", `${operation}.json`);
const originalJournal = readFileSync(journalPath);
const journal = JSON.parse(originalJournal.toString());
const config = journal.config;
const request = journal.request;
const upload = journal.upload_receipt;
assert.equal(journal.phase, "deploy_requested");
assert(upload && !journal.deployment_receipt && !journal.target);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, config.account_id);
assert(process.env.CLOUDFLARE_API_TOKEN);
assert(!existsSync(evidence), "Preserve earlier investigation; never replace evidence");
mkdirSync(evidence, { mode: 0o700 });

const save = (name: string, value: unknown) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const base = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}`;
const worker = `/workers/scripts/${config.worker_name}`;
const timings: { name: string; method: "GET"; elapsed_ms: number; status?: number; success: boolean }[] = [];
let stage = "before_requests";

async function get(name: string, path: string, object = false): Promise<unknown> {
  stage = name;
  const start = performance.now();
  const timing: (typeof timings)[number] = { name, method: "GET", elapsed_ms: 0, success: false };
  timings.push(timing);
  try {
    const response = await fetch(base + path, { method: "GET", headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
    }, signal: AbortSignal.timeout(30000), redirect: "error" });
    timing.status = response.status;
    assert(response.ok, "Read-only request rejected; stop without retries");
    const body = await response.json();
    if (!object) assert(body.success === true, "Cloudflare result was not successful");
    const value = object ? body : body.result;
    save(name + "-private.json", value);
    timing.success = true;
    return value;
  } finally {
    timing.elapsed_ms = performance.now() - start;
    save("read-timings.json", timings);
  }
}

function metadata(settings: unknown) {
  const parsed = workerSettingsSnapshotSchema.parse(settings);
  assert(parsed.compatibility_date);
  const value = buildM6WorkerUploadMetadata(config, parsed, "", parsed.compatibility_date);
  value.bindings = value.bindings.map(binding => binding.type === "inherit"
    ? { ...binding, version_id: request.previous_worker_version_id } : binding);
  return value;
}

try {
  const settingsBefore = await get("settings-before", worker + "/settings");
  const deploymentBefore = workerDeploymentsSnapshotSchema.parse(await get("deployments-before", worker + "/deployments"));
  const versionsBefore = workerVersionsSnapshotSchema.parse(await get("versions-before", worker + "/versions?page=1&per_page=2"));
  const uploadedVersion = workerVersionSnapshotSchema.parse(await get("uploaded-version", worker + "/versions/" + upload.id));
  const oldVersion = workerVersionSnapshotSchema.parse(await get("previous-version", worker + "/versions/" + request.previous_worker_version_id));
  const r2 = `/r2/buckets/${config.bucket_name}/objects/`;
  const admission = serviceAdmissionSchema.parse(await get("admission", r2 + "system/lifecycle-service.json", true));
  const frozen = await get("frozen-request", r2 + `system/service-updates/${operation}/request.json`, true);
  const show = parseShowControl(await get("show-control", r2 + "system/show-publications/otftalk-rss.json", true));
  const settingsAfter = await get("settings-after", worker + "/settings");
  const deploymentAfter = workerDeploymentsSnapshotSchema.parse(await get("deployments-after", worker + "/deployments"));
  const versionsAfter = workerVersionsSnapshotSchema.parse(await get("versions-after", worker + "/versions?page=1&per_page=2"));
  stage = "validate_snapshots";
  assert.deepEqual(readFileSync(journalPath), originalJournal, "Local journal changed during investigation");
  assert(!existsSync(journalPath + ".lock"), "An unknown lock remains");
  assert.equal(uploadedVersion.id, upload.id);
  assert.equal(uploadedVersion.resources.script.etag, upload.resources.script.etag);
  assert.equal(oldVersion.id, request.previous_worker_version_id);
  assert.deepEqual(versionsBefore, versionsAfter);
  assert.equal(versionsBefore.items[0].id, upload.id);
  assert.equal(versionsBefore.items[0].number, upload.number);
  assert.equal(versionsBefore.items[1]?.id, request.previous_worker_version_id);
  assert.equal(versionsBefore.items[1]?.number, upload.number - 1);
  assert.deepEqual(deploymentBefore, deploymentAfter);
  const current = deploymentBefore.deployments[0];
  const previous = JSON.parse(readFileSync(join(root, "evidence/rss-performance-a8c7e54/before-service.stdout"), "utf8"));
  assert.equal(current.id, previous.admission.runtime_readiness.deployment_id);
  assert.deepEqual(current.versions, [{ version_id: request.previous_worker_version_id, percentage: 100 }]);
  assert.equal(sha(JSON.stringify(metadata(settingsBefore))), request.worker_metadata_sha256);
  assert.equal(sha(JSON.stringify(metadata(settingsAfter))), request.worker_metadata_sha256);
  assert.equal(admission.state, "updating");
  assert.equal(admission.invocations.length, 0);
  assert.deepEqual(admission.update?.request, request);
  assert(!admission.update?.target);
  assert.deepEqual(frozen, request);
  assert.equal(admission.pause_id, request.pause_id);
  assert.equal(admission.generation, request.expected_service_generation + 1);
  assert.equal(show.owner, null);
  assert(!show.episode_catalog_initialized);
  const result = {
    operation_id: operation, observed_at: new Date().toISOString(), read_only: true,
    requests_get_only: timings.every(row => row.method === "GET"), request_count: timings.length,
    all_reads_succeeded: true, previously_timed_out_settings_now_readable: true,
    settings_match_frozen_intent: true, snapshot_history_stable: true,
    acknowledged_uploaded_version_id: upload.id, uploaded_version_etag_matches_receipt: true,
    latest_two_version_ids: versionsBefore.items.map(row => row.id), upload_number: upload.number,
    active_worker_version_id: request.previous_worker_version_id, active_deployment_id: current.id,
    active_deployment_matches_pre_update: true, new_version_not_currently_active: true,
    service_state: admission.state, invocations_empty: true,
    exact_frozen_request_matches_local_and_admission: true, update_target_absent: true,
    show_owner_absent: true, episode_catalog_not_initialized: true,
    local_journal_bytes_unchanged: true, local_journal_sha256: sha(originalJournal),
    local_update_lock_absent: true, no_deploy_or_activation_or_completion_or_resume_sent: true,
    limitations: ["GET snapshots do not alone prove that no earlier or future outside activation request exists",
      "No network root cause attribution; successful settings reads now do not explain the original timeout",
      "Receipt-only resume remains unsupported by the unmodified CLI; no journal or remote state was repaired"],
  };
  save("findings.json", result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  save("failure.json", { failed_stage: stage, read_only: true, mutations_sent: false });
  writeFileSync(join(evidence, "failure-private.txt"), String(error) + "\n", { mode: 0o600 });
  console.error("Read-only investigation stopped; inspect private evidence. No mutation was performed.");
  process.exitCode = 1;
}
