import { sanitizeSqliteInvocation, SqliteObservationGuard, SqliteTailFrameError } from "./sqlite-observability";
import type { SqliteInvocation } from "./sqlite-observability";
import { startWorkerTail } from "./worker-tail";
import type { TailHealth, TailSocket, WorkerTailOptions } from "./worker-tail";

type Options = Pick<WorkerTailOptions, "create" | "list" | "onHealth" | "socket" | "pingIntervalMs" | "registryIntervalMs" | "connectTimeoutMs"> & {
  onInvocation: (row: SqliteInvocation) => void;
  onCaptureFailure?: (diagnostic: SqliteCaptureFailure) => void;
};
export type SqliteCaptureFailure = { event: "sqlite_tail_capture";
  reason_code: "frame_format_unverified" | "frame_json_unverified" | "frame_schema_unverified" | "frame_capture_failed"; fields: string[] };

export type SqliteTrialTail = {
  rows: SqliteInvocation[]; guard: SqliteObservationGuard; assertHealthy: () => void; assertCanMutate: () => void;
  hasProbeCpu: (id: string, version: string) => boolean;
  stop: () => TailHealth & { capture_fault: boolean; capture_complete: boolean; rejected_frames: number;
    first_capture_failure?: SqliteCaptureFailure; reconciliation_pending: number };
};
export async function startSqliteTrialTail(options: Options): Promise<SqliteTrialTail> {
  const rows: SqliteInvocation[] = [], guard = new SqliteObservationGuard(); let rejectedFrames = 0, firstFailure: SqliteCaptureFailure | undefined;
  const tail = await startWorkerTail({ ...options, onInvocation: () => {}, socket: (url) => {
    const socket = options.socket ? options.socket(url) : new WebSocket(url, "trace-v1") as unknown as TailSocket;
    socket.addEventListener("message", (event) => {
      try {
        const row = sanitizeSqliteInvocation((event as { data: unknown }).data);
        options.onInvocation(row); rows.push(row); guard.record(row);
      } catch (error) {
        rejectedFrames++;
        const diagnostic: SqliteCaptureFailure = { event: "sqlite_tail_capture", reason_code: error instanceof SqliteTailFrameError ? error.reasonCode : "frame_capture_failed",
          fields: error instanceof SqliteTailFrameError ? error.fields : [] };
        firstFailure ??= diagnostic;
        try { options.onCaptureFailure?.(diagnostic); } catch {}
      }
    });
    return socket;
  } });
  const assertHealthy = () => {
    tail.assertHealthy(); guard.assertHealthy();
    if (rejectedFrames) throw new Error("SQLite tail frame or capture failed; preserve pending operations");
  };
  return { rows, guard, assertHealthy,
    assertCanMutate: () => { assertHealthy(); guard.assertCanMutate(); },
    hasProbeCpu: (id: string, version: string) => rows.some((row) => row.probe_id === id && row.kind === "outer-http" &&
      row.worker_version_id === version && typeof row.cpu_ms === "number"),
    stop: () => {
      tail.stop(); const summary = tail.summary();
      return { ...summary, capture_fault: rejectedFrames > 0, capture_complete: summary.complete && rejectedFrames === 0 && summary.invocation_count === rows.length,
        rejected_frames: rejectedFrames, first_capture_failure: firstFailure, reconciliation_pending: guard.pendingReconciliation().length };
    } };
}
