import { m6ServiceAdminResponseSchema, parseServiceConfig } from "../../packages/shared/src/index";
import { readLocalM6Update } from "../../packages/cli/src/m6-service-update";
import { digestAcceptanceResponse, expectStandaloneRejection, standaloneCommand } from "./standalone-harness";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.argv.length !== 3) throw new Error("Provide the acknowledged lifecycle-acceptance workspace");
const root = resolve(process.argv[2]!);
const config = parseServiceConfig(await readFile(join(root, "castloop.toml"), "utf8"));
const previous = JSON.parse(await readFile(join(root, "lifecycle-acceptance.json"), "utf8")) as {
  result: string; name: string; pause_id: string; worker_version_id: string;
};
assert.ok(previous.result === "lifecycle_binary_acceptance_passed" && previous.name === config.worker_name &&
  config.account_id === process.env.CLOUDFLARE_ACCOUNT_ID && config.service_id.startsWith("m6-test-") &&
  [config.worker_name, config.bucket_name, config.queue_name, config.dlq_name].every((name) => name.startsWith("castloop-m6-test-")),
  "Only the acknowledged isolated service is permitted");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const command = (...args: string[]) => standaloneCommand(root, ...args);
const status = async () => m6ServiceAdminResponseSchema.parse(await command("service-status"));
const operationId = crypto.randomUUID();
let phase = "preflight";
try {
  const before = await status();
  assert.equal(before.admission.state, "paused");
  assert.equal(before.admission.pause_id, previous.pause_id);
  assert.equal(before.worker_version_id, previous.worker_version_id);
  assert.equal(before.admission.invocations.length, 0);
  await writeFile(join(root, "completion-recovery-before.json"), JSON.stringify({ name: config.worker_name, operation_id: operationId,
    previous_worker_version_id: before.worker_version_id }), { mode: 0o600, flag: "wx" });
  phase = "update-and-deliberate-completion-loss";
  const rejection = await expectStandaloneRejection(root, "update-service-drop-completion", operationId);
  assert.ok(rejection.includes("Setup completion request outcome is unknown"), "Fault must occur after the completion request, not at an earlier step");
  const requested = readLocalM6Update(root, config, operationId);
  assert.equal(requested.state?.phase, "completion_requested");
  assert.equal(requested.lockPresent, false);
  const completed = await status();
  assert.equal(completed.admission.state, "paused");
  assert.equal(completed.admission.pause_id, previous.pause_id);
  assert.equal(completed.admission.invocations.length, 0);
  assert.equal(completed.admission.runtime_readiness?.operation_id, operationId);
  assert.equal(completed.worker_version_id, requested.state?.target?.worker_version_id);
  assert.notEqual(completed.worker_version_id, before.worker_version_id);
  const recordUrl = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/${config.bucket_name}/objects/system/runtime-checks/${operationId}.json`;
  const snapshot = async () => {
    const response = await fetch(recordUrl, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
    return { etag: response.headers.get("ETag"), ...await digestAcceptanceResponse(response, 16384) };
  };
  const record = await snapshot();
  phase = "readonly-standalone-reconciliation";
  const receipt = await command("update-service-reconcile", operationId) as { result: string };
  assert.equal(receipt.result, "updated-paused");
  assert.equal(readLocalM6Update(root, config, operationId).state?.phase, "completed");
  assert.deepEqual(await status(), completed);
  assert.deepEqual(await snapshot(), record);
  await writeFile(join(root, "completion-recovery-acceptance.json"), JSON.stringify({ result: "completion_recovery_binary_passed",
    name: config.worker_name, operation_id: operationId, worker_version_id: completed.worker_version_id,
    pause_id: previous.pause_id, requested_after_lost_completion: true, completed_after_readonly_reconciliation: true,
    service_and_runtime_receipt_unchanged: true, resources_retained_paused: true, forced_termination_io_proven: false,
    authorizes_release: false }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ result: "completion_recovery_binary_passed", workspace: root, resources_retained_paused: true }));
} catch {
  await writeFile(join(root, "completion-recovery-incomplete.json"), JSON.stringify({ result: "completion_recovery_acceptance_incomplete",
    operation_id: operationId, phase, authorizes_recovery: false, resources_not_deleted: true }, null, 2), { mode: 0o600, flag: "wx" });
  console.error(`Completion recovery acceptance did not complete (${phase}); no replay, resource adoption or automatic resume.`);
  process.exitCode = 1;
}
