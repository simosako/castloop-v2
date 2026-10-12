import type { LifecycleProgress } from "../packages/shared/src/index";

type WorkerTimingPhase = "publication.consumer" | "publication.guard" | "publication.verify_staging" |
  "publication.unique_guid" | "publication.audio" | "publication.feed_inputs" | "publication.purge" |
  `publication.progress.${LifecycleProgress["phase"]}` | `publication.status_write.${"processing" | "retrying" | "published"}` |
  "publication.history_write" | "publication.metadata_write" | "publication.feed_write" | "publication.owner_release" | "publication.invocation_release" |
  "publication.claim" | "publication.commit" | "publication.retry" | "publication.release" | "publication.status" |
  "staging.claim" | "staging.begin" | "staging.settle" | "staging.finish" | "staging.status";

function emit(record: object): void {
  try { console.log(JSON.stringify(record)); }
  catch { return; }
}

export async function measureWorkerPhase<T>(jobId: string, phase: WorkerTimingPhase,
  operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const started = performance.now();
  let outcome: "success" | "error" = "error";
  try {
    const result = await operation();
    outcome = "success";
    return result;
  } finally {
    emit({ event: "worker_timing", job_id: jobId, phase, outcome,
      started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(),
      duration_ms: Math.max(0, performance.now() - started) });
  }
}

export function logPublicationDelivery(jobId: string, timestamp: Date | undefined, attempts: number | undefined): void {
  emit({ event: "publication_delivery", job_id: jobId, delivered_at: new Date().toISOString(),
    message_timestamp: timestamp instanceof Date && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null,
    attempts: Number.isSafeInteger(attempts) && attempts! > 0 ? attempts : null });
}
