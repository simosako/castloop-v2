import { managementRequestPrefix, m6ServiceConfigHash, parseShowControl, publicationManifestHash,
  stageControlRequest, stagePayloadKey, verifyManagementIntent } from "../packages/shared/src/index";
import type { ManagementIntent, ManagementResult, ServiceConfig } from "../packages/shared/src/index";
import { putPublicDeliveryRecord } from "./public-delivery-records";
import { acquireShowExecution, controlRequestHash, readEpisodeLifecycle, readShowControl, requireOwnedOperation } from "./lifecycle-control";
import { LifecycleExecutionBusy, releaseSettledExecution } from "./lifecycle-consumer";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { createM6DeliveryGate } from "./lifecycle-delivery-gate";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import { bindManagementOperation, ManagementRequestConflict, readManagementResult, retainManagementRequest, writeManagementResult } from "./management-request-store";
import { claimPublicationOperation, commitExecutingPublication } from "./publication-admission";
import { runPublicationExecution } from "./publication-consumer";
import type { PublicationEffectFactory } from "./publication-consumer";
import { inspectPublication } from "./publication-inspection";
import { acquireServiceInvocation, releaseServiceInvocation, requireM6ServiceRuntime, ServiceAdmissionBlocked } from "./service-admission";
import { beginStageUpload, claimStageUpload, readStageUploadProgress, requireStageUpload,
  settleStageUpload, stageCommandEnv, stageManifestHash } from "./staging-upload";
import type { StageOperation } from "./staging-upload";
import { runStageVerification } from "./staging-verification";
import { measureWorkerPhase } from "./worker-timing";

async function acquireStageCommand(env: LifecycleFeedEnv, operation: StageOperation, executionId: string): Promise<void> {
  const current = await requireOwnedOperation(env, operation.showId, operation.operationId, operation.generation);
  if (current.value.owner.action !== "stage" || current.value.owner.verification_id || current.value.owner.command_execution_id) {
    throw new LifecycleExecutionBusy();
  }
  const value = parseShowControl({ ...current.value, owner: { ...current.value.owner, command_execution_id: executionId } });
  if (!await putPublicDeliveryRecord(env, `system/show-publications/${operation.showId}.json`, JSON.stringify(value),
    { onlyIf: { etagMatches: current.etag } })) throw new LifecycleExecutionBusy();
}

async function releaseStageCommand(env: LifecycleFeedEnv, operation: StageOperation, executionId: string): Promise<void> {
  const current = await readShowControl(env, operation.showId);
  if (current?.value.last_finished_upload?.operation_id === operation.operationId &&
    current.value.last_finished_upload.generation === operation.generation) return;
  if (!current || current.value.generation !== operation.generation || current.value.owner?.job_id !== operation.operationId ||
    current.value.owner.command_execution_id !== executionId || current.value.owner.verification_id) {
    throw new Error("Staging command no longer owns its settled execution");
  }
  const { command_execution_id: _token, ...owner } = current.value.owner;
  const value = parseShowControl({ ...current.value, owner });
  if (!await putPublicDeliveryRecord(env, `system/show-publications/${operation.showId}.json`, JSON.stringify(value),
    { onlyIf: { etagMatches: current.etag } })) throw new Error("Staging command execution return conflicted");
}

async function requireGrant(env: LifecycleFeedEnv, intent: ManagementIntent, secret: string): Promise<ManagementIntent> {
  if (intent.command.action !== "upload-complete") throw new Error("Expected an upload completion command");
  const object = await env.CASTLOOP_BUCKET.get(`${managementRequestPrefix(intent.command.grant_request_id)}/intent.json`);
  if (!object || object.size < 1 || object.size > 16384) { await object?.body?.cancel(); throw new ManagementRequestConflict(); }
  const grant = await verifyManagementIntent(await object.json<unknown>(), secret);
  if (!grant || grant.command.action !== "stage-start" || grant.service_id !== intent.service_id ||
    grant.worker_version_id !== intent.worker_version_id || grant.service_config_sha256 !== intent.service_config_sha256 ||
    grant.admission_window_id !== intent.admission_window_id || JSON.stringify(grant.command.upload) !== JSON.stringify(intent.command.upload) ||
    (await readManagementResult(env, grant, secret))?.state !== "granted") throw new ManagementRequestConflict();
  return grant;
}

async function uploadCommand(env: LifecycleFeedEnv, intent: ManagementIntent, secret: string, gate: () => Promise<void>): Promise<void> {
  const command = intent.command;
  if (command.action === "publish") throw new Error("Expected a staging command");
  const upload = command.upload;
  const operation = { showId: upload.show_id, operationId: upload.operation_id, generation: upload.expected_show_generation + 1 };
  if (command.action === "upload-complete") await requireGrant(env, intent, secret);
  const before = await readShowControl(env, operation.showId);
  if (command.action === "upload-complete" && before?.value.last_finished_upload?.operation_id === operation.operationId &&
    before.value.last_finished_upload.generation === operation.generation &&
    before.value.last_finished_upload.manifest_sha256 === await stageManifestHash(upload) &&
    before.value.last_finished_upload.request_sha256 === await controlRequestHash(stageControlRequest(upload)) &&
    before.value.last_finished_upload.outcome === command.outcome) {
    await runStageVerification(env, operation, command.outcome);
    await writeManagementResult(env, intent, secret, { state: command.outcome });
    return;
  }
  const executionId = crypto.randomUUID();
  const scoped = stageCommandEnv(env, executionId);
  let acquired = false;
  try {
    if (before?.value.owner) {
      await acquireStageCommand(env, operation, executionId);
      acquired = true;
    }
    if (command.action === "stage-start") {
      await claimStageUpload(scoped, upload);
      acquired = true;
      const snapshot = await requireStageUpload(scoped, operation);
      if (JSON.stringify(snapshot.request) !== JSON.stringify(upload)) throw new ManagementRequestConflict();
      const progress = await readStageUploadProgress(scoped, operation, snapshot);
      const payloads = progress?.value.phase === "ready" ? await beginStageUpload(scoped, operation) :
        progress?.value.phase === "uploading" && !progress.value.client_settled ? upload.payloads.map((payload) =>
          ({ key: stagePayloadKey(upload, payload.asset), length: payload.length_bytes, sha256: payload.sha256 })) : null;
      if (!payloads) throw new Error("Staging grant cannot reopen settled PUT permission");
      await gate();
      await writeManagementResult(env, intent, secret, { state: "granted", payloads });
    } else {
      if (!acquired) throw new Error("Upload completion has no admitted owner");
      const snapshot = await requireStageUpload(scoped, operation);
      if (JSON.stringify(snapshot.request) !== JSON.stringify(upload)) throw new ManagementRequestConflict();
      await settleStageUpload(scoped, operation, command.settlement);
      await gate();
      await runStageVerification(scoped, operation, command.outcome);
      await gate();
      await writeManagementResult(env, intent, secret, { state: command.outcome });
    }
  } finally {
    if (!acquired) {
      const current = await readShowControl(env, operation.showId);
      acquired = current?.value.generation === operation.generation && current.value.owner?.job_id === operation.operationId &&
        current.value.owner.command_execution_id === executionId;
    }
    if (acquired) await releaseStageCommand(env, operation, executionId);
  }
}

async function publishCommand(env: LifecycleFeedEnv, intent: ManagementIntent, secret: string,
  source: PublicationEffectFactory, gate: () => Promise<void>): Promise<void> {
  if (intent.command.action !== "publish") throw new Error("Expected a publication command");
  const publication = intent.command.publication;
  const request = publication.request;
  const current = await readShowControl(env, request.show_id);
  if (current?.value.last_finished_operation?.job_id === request.job_id &&
    current.value.last_finished_operation.generation === request.expected_show_generation + 1 &&
    current.value.last_finished_operation.request_sha256 === await controlRequestHash(request)) {
    const status = await inspectPublication(env, intent.service_id, publication);
    if (status.status?.state !== "published" || status.ownership !== "released") throw new Error("Publication completion proof is inconsistent");
    await writeManagementResult(env, intent, secret, { state: "published" });
    return;
  }
  if (current?.value.owner?.execution_id) throw new LifecycleExecutionBusy();
  const executionId = crypto.randomUUID();
  let execution = { showId: request.show_id, jobId: request.job_id, generation: request.expected_show_generation + 1, executionId };
  let result;
  try {
    const operation = await claimPublicationOperation(env, publication, executionId);
    const owned = await requireOwnedOperation(env, operation.showId, operation.jobId, operation.generation);
    execution = owned.value.owner.execution_id === executionId ? { ...operation, executionId } :
      await acquireShowExecution(env, operation.showId, operation.jobId, operation.generation);
    result = await runPublicationExecution(env, execution, request.kind, source, async (scoped) => {
      await gate();
      await commitExecutingPublication(scoped, execution, { manifest_sha256: await publicationManifestHash(publication),
        request_sha256: await controlRequestHash(request) });
    });
  } catch (error) {
    const settled = await readShowControl(env, execution.showId);
    if (settled?.value.generation === execution.generation && settled.value.owner?.job_id === execution.jobId &&
      settled.value.owner.execution_id === execution.executionId) await releaseSettledExecution(env, execution);
    throw error;
  }
  await gate();
  await writeManagementResult(env, intent, secret, result.state === "failed" ? { state: "failed", reason_code: "validation_failed" } : { state: "published" });
}

export async function consumeManagementIntent(env: LifecycleFeedEnv, intent: ManagementIntent, config: ServiceConfig,
  secret: string, bindings: M6DeliveryGateBindings,
  source: (gate: () => Promise<void>) => PublicationEffectFactory, deadLetter = false): Promise<void> {
  let result: ManagementResult;
  try { result = await retainManagementRequest(env, intent, secret); }
  catch (error) {
    if (!(error instanceof ManagementRequestConflict)) throw error;
    console.error(JSON.stringify({ event: "management_command_blocked", request_id: intent.request_id, reason_code: "request_conflict" }));
    return;
  }
  if (result.state !== "pending") return;
  if (deadLetter) {
    await writeManagementResult(env, intent, secret, { state: "blocked", reason_code: "retries_exhausted" });
    return;
  }
  if (intent.service_id !== config.service_id || intent.worker_version_id !== bindings.versionMetadata.id ||
    intent.service_config_sha256 !== await m6ServiceConfigHash(config)) {
    await writeManagementResult(env, intent, secret, { state: "rejected", reason_code: "runtime_mismatch" });
    return;
  }
  const runtime = await requireM6ServiceRuntime(env, config.service_id, bindings.versionMetadata.id);
  if (runtime.value.runtime_readiness?.management_protocol !== "queue-management-v1") {
    await writeManagementResult(env, intent, secret, { state: "rejected", reason_code: "runtime_mismatch" });
    return;
  }
  if (runtime.value.last_resumed_pause_id !== intent.admission_window_id) {
    await writeManagementResult(env, intent, secret, { state: "rejected", reason_code: "stale_window" });
    return;
  }
  try { await bindManagementOperation(env, intent); }
  catch (error) {
    if (!(error instanceof ManagementRequestConflict)) throw error;
    await writeManagementResult(env, intent, secret, { state: "rejected", reason_code: "request_conflict" });
    return;
  }
  const target = intent.command.action === "publish" ? intent.command.publication.request : intent.command.upload;
  const jobId = intent.command.action === "publish" ? intent.command.publication.request.job_id : intent.command.upload.operation_id;
  const control = await readShowControl(env, target.show_id);
  const requestHash = await controlRequestHash(intent.command.action === "publish" ? intent.command.publication.request : stageControlRequest(intent.command.upload));
  const admitted = !!control && control.value.owner?.job_id === jobId && control.value.owner.request_sha256 === requestHash &&
    control.value.generation === target.expected_show_generation + 1;
  const receipt = intent.command.action === "publish" ? control?.value.last_finished_operation : control?.value.last_finished_upload;
  const completed = receipt?.generation === target.expected_show_generation + 1 && receipt.request_sha256 === requestHash &&
    (intent.command.action === "publish" ? control?.value.last_finished_operation?.job_id === jobId :
      intent.command.action === "upload-complete" && control?.value.last_finished_upload?.operation_id === jobId);
  const episode = target.kind === "episode" && !admitted && !completed ? await readEpisodeLifecycle(env, target.show_id, target.episode_id!) : null;
  const episodeEligible = target.kind === "show" || admitted || completed ||
    episode && ["draft", "active"].includes(episode.lifecycle) && episode.generation === target.expected_episode_generation ||
    !episode && intent.command.action === "stage-start" && target.expected_episode_generation === 0;
  const showEligible = !!control && (target.kind === "show" ? ["draft", "active"].includes(control.value.lifecycle) : control.value.lifecycle === "active");
  if (!admitted && !completed && (!control || control.value.owner || control.value.generation !== target.expected_show_generation ||
    runtime.value.state !== "open" || !episodeEligible || !showEligible || intent.command.action === "upload-complete")) {
    await writeManagementResult(env, intent, secret, { state: "rejected", reason_code: "target_conflict" });
    return;
  }
  let invocation;
  try { invocation = await acquireServiceInvocation(env, config.service_id, admitted || completed ? "m6_consumer" : "m6_admin",
    { admissionWindowId: intent.admission_window_id, workerVersionId: intent.worker_version_id }); }
  catch (error) {
    if (!(error instanceof ServiceAdmissionBlocked)) throw error;
    await writeManagementResult(env, intent, secret, { state: "rejected", reason_code: "stale_window" });
    return;
  }
  try {
    const gate = createM6DeliveryGate(env, invocation, bindings);
    const checkGate = () => gate({ showId: target.show_id, ...(target.episode_id ? { episodeId: target.episode_id } : {}) });
    await checkGate();
    await measureWorkerPhase(jobId!, `management.${intent.command.action}`, async () => {
      if (intent.command.action === "publish") await publishCommand(env, intent, secret, source(checkGate), checkGate);
      else await uploadCommand(env, intent, secret, checkGate);
    });
  } finally { await releaseServiceInvocation(env, invocation); }
}
