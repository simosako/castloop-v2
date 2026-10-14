import { m6ServiceConfigHash, publicationManifestHash, publicationRequestSchema } from "../packages/shared/src/index";
import type { PublicationCommitIntent, ServiceConfig } from "../packages/shared/src/index";
import { acquireShowExecution, readShowControl } from "./lifecycle-control";
import { LifecycleExecutionBusy } from "./lifecycle-consumer";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { commitExecutingPublication, InvalidFrozenPublication, requireOwnedPublication } from "./publication-admission";
import { runPublicationExecution } from "./publication-consumer";
import type { PublicationEffectFactory } from "./publication-consumer";
import { inspectPublication } from "./publication-inspection";
import { advancePublicationSubmission, PublicationSubmissionConflict, retainPublicationSubmission } from "./publication-submission-store";
import { logPublicationExecutionBlocked, measureWorkerPhase } from "./worker-timing";

export async function requirePublicationIntentRuntime(intent: PublicationCommitIntent, config: ServiceConfig,
  workerVersionId: string): Promise<void> {
  if (intent.service_id !== config.service_id || intent.worker_version_id !== workerVersionId ||
    intent.service_config_sha256 !== await m6ServiceConfigHash(config)) {
    throw new Error("Publication intent targets another service configuration or Worker runtime");
  }
}

export async function consumePublicationCommitIntent(env: LifecycleFeedEnv, intent: PublicationCommitIntent,
  source: PublicationEffectFactory, checkGate: () => Promise<void>): Promise<void> {
  await checkGate();
  let retained;
  try { retained = await retainPublicationSubmission(env, intent); }
  catch (error) {
    if (!(error instanceof PublicationSubmissionConflict)) throw error;
    console.error(JSON.stringify({ event: "publication_submission_blocked", job_id: intent.operation.job_id,
      submission_id: intent.submission_id, reason_code: "intent_mismatch" }));
    return;
  }
  if (["completed", "failed", "rejected"].includes(retained.result.state)) return;
  const operation = { showId: intent.operation.show_id, jobId: intent.operation.job_id, generation: intent.operation.show_generation };
  const current = await readShowControl(env, operation.showId);
  if (!current || current.value.generation !== operation.generation || current.value.owner?.job_id !== operation.jobId) {
    const receipt = current?.value.last_finished_operation;
    if (receipt?.job_id === operation.jobId && receipt.generation === operation.generation && receipt.request_sha256 === intent.request_sha256) {
      const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${operation.jobId}/publication.json`);
      if (!object) throw new InvalidFrozenPublication();
      if (object.size < 1 || object.size > 16384) { await object.body?.cancel(); throw new InvalidFrozenPublication(); }
      const frozen = publicationRequestSchema.parse(await object.json<unknown>());
      if (await publicationManifestHash(frozen) !== intent.manifest_sha256) throw new InvalidFrozenPublication();
      const status = await inspectPublication(env, intent.service_id, frozen);
      if (status.status?.state !== "published" || status.ownership !== "released") throw new InvalidFrozenPublication();
      await advancePublicationSubmission(env, intent, "completed");
    } else await advancePublicationSubmission(env, intent, "rejected", "stale_claim");
    return;
  }
  if (current.value.owner.execution_id) {
    logPublicationExecutionBlocked(operation.jobId);
    throw new LifecycleExecutionBusy();
  }
  let owned;
  try {
    owned = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
    if (await publicationManifestHash(owned.frozen) !== intent.manifest_sha256 ||
      owned.control.value.owner.request_sha256 !== intent.request_sha256) throw new InvalidFrozenPublication();
  } catch (error) {
    if (!(error instanceof InvalidFrozenPublication)) throw error;
    await advancePublicationSubmission(env, intent, "rejected", "intent_mismatch");
    return;
  }
  await checkGate();
  const execution = await measureWorkerPhase(operation.jobId, "publication.execution_acquire", () =>
    acquireShowExecution(env, operation.showId, operation.jobId, operation.generation));
  const result = await runPublicationExecution(env, execution, owned.frozen.request.kind, source, async (executionEnv) => {
    await checkGate();
    await measureWorkerPhase(operation.jobId, "publication.queue_commit", () => commitExecutingPublication(executionEnv, execution, intent));
    await advancePublicationSubmission(env, intent, "committed");
  });
  if (result.state === "failed") await advancePublicationSubmission(env, intent, "failed", "validation_failed");
  else if (result.state === "completed") await advancePublicationSubmission(env, intent, "completed");
}
