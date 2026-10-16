import { sanitizeSqliteInvocation, SqliteObservationGuard } from "./sqlite-observability";
import type { SqliteInvocation } from "./sqlite-observability";
import { startWorkerTail } from "./worker-tail";
import type { TailHealth, TailSocket, WorkerTailOptions } from "./worker-tail";

type Options = Pick<WorkerTailOptions, "create" | "list" | "onHealth" | "socket" | "pingIntervalMs" | "registryIntervalMs" | "connectTimeoutMs"> & {
  onInvocation: (row: SqliteInvocation) => void;
};

export type SqliteTrialTail = {
  rows: SqliteInvocation[]; guard: SqliteObservationGuard; assertHealthy: () => void; assertCanMutate: () => void;
  hasProbeCpu: (id: string, version: string) => boolean;
  stop: () => TailHealth & { capture_fault: boolean; reconciliation_pending: number };
};
export async function startSqliteTrialTail(options: Options): Promise<SqliteTrialTail> {
  const rows: SqliteInvocation[] = [], guard = new SqliteObservationGuard(); let captureFailed = false;
  const tail = await startWorkerTail({ ...options, onInvocation: () => {}, socket: (url) => {
    const socket = options.socket ? options.socket(url) : new WebSocket(url, "trace-v1") as unknown as TailSocket;
    socket.addEventListener("message", (event) => {
      try {
        const row = sanitizeSqliteInvocation((event as { data: unknown }).data);
        options.onInvocation(row); rows.push(row); guard.record(row);
      } catch { captureFailed = true; }
    });
    return socket;
  } });
  const assertHealthy = () => {
    tail.assertHealthy(); guard.assertHealthy();
    if (captureFailed) throw new Error("SQLite tail frame or capture failed; preserve pending operations");
  };
  return { rows, guard, assertHealthy,
    assertCanMutate: () => { assertHealthy(); guard.assertCanMutate(); },
    hasProbeCpu: (id: string, version: string) => rows.some((row) => row.probe_id === id && row.kind === "outer-http" &&
      row.worker_version_id === version && typeof row.cpu_ms === "number"),
    stop: () => { tail.stop(); return { ...tail.summary(), capture_fault: captureFailed, reconciliation_pending: guard.pendingReconciliation().length }; } };
}
