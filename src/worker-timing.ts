import type { LifecycleProgress } from "../packages/shared/src/index";

type WorkerTimingPhase = "publication.consumer" | "publication.guard" | "publication.verify_staging" |
  "publication.frozen_commit" | "publication.owner_check" | "publication.execution_acquire" |
  "publication.execution_context" | "publication.effects" | "publication.runner" |
  "publication.invocation_acquire" | "publication.execution_cleanup" | "publication.failure_record" |
  "publication.runner_control" | "publication.runner_manifest" | "publication.journal_read" |
  "publication.guard_owner" | "publication.guard_delivery" | "publication.guard_recheck" |
  "publication.audio_owner" | "publication.audio_target_head" | "publication.audio_source_head" |
  "publication.audio_source_get" | "publication.audio_put" | "publication.audio_verify_head" |
  "publication.audio_recheck" | "publication.body_cancel" | "publication.snapshots" |
  "publication.feed_generation" | "publication.catalog_advance" | "publication.feed_generation_write" |
  "publication.visibility" |
  "publication.unique_guid" | "publication.audio" | "publication.feed_inputs" | "publication.purge" |
  `publication.progress.${LifecycleProgress["phase"]}` | `publication.status_write.${"processing" | "retrying" | "failed" | "published"}` |
  "publication.history_write" | "publication.metadata_write" | "publication.feed_write" | "publication.cover_write" |
  "publication.owner_release" | "publication.invocation_release" |
  "publication.claim" | "publication.commit" | "publication.queue_commit" | "publication.retry" | "publication.release" | "publication.status" |
  "staging.claim" | "staging.begin" | "staging.settle" | "staging.finish" | "staging.status";

function emit(record: object): void {
  try { console.log(JSON.stringify(record)); }
  catch { return; }
}

export async function measureWorkerPhase<T>(jobId: string, phase: WorkerTimingPhase,
  operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const started = performance.now();
  const timingId = crypto.randomUUID();
  emit({ event: "worker_phase_started", job_id: jobId, phase, timing_id: timingId,
    started_at: new Date(startedAt).toISOString() });
  let outcome: "success" | "error" = "error";
  try {
    const result = await operation();
    outcome = "success";
    return result;
  } finally {
    emit({ event: "worker_timing", job_id: jobId, phase, timing_id: timingId, outcome,
      started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(),
      duration_ms: Math.max(0, performance.now() - started) });
  }
}

export function logPublicationExecutionBlocked(jobId: string): void {
  emit({ event: "publication_execution_blocked", job_id: jobId, reason_code: "retained_execution_token",
    authorizes_recovery: false });
}

export function logPublicationDelivery(jobId: string, timestamp: Date | undefined, attempts: number | undefined): void {
  emit({ event: "publication_delivery", job_id: jobId, delivered_at: new Date().toISOString(),
    message_timestamp: timestamp instanceof Date && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null,
    attempts: Number.isSafeInteger(attempts) && attempts! > 0 ? attempts : null });
}
