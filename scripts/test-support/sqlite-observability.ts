import { z } from "zod";
import { sqliteHealthSchema } from "../../packages/shared/src/sqlite-service-api";
import { sqlitePublicationStatusSchema } from "./legacy-sqlite-publication";
import { operationPhaseSchema, operationReasonSchema, operationStateSchema } from "./legacy-sqlite-operations";

const diagnosticSchema = z.union([
  z.object({ event: z.literal("sqlite_publication"), phase: z.enum(["started", "succeeded", "failed", "blocked"]), job_id: z.uuid(),
    request_id: z.uuid(), sequence: z.number().int().positive(), reason_code: z.enum(["validation_failed", "base_conflict", "target_unavailable", "stale_window", "runtime_mismatch", "execution_interrupted", "validation_unavailable", "execution_failed", "stored_request_invalid"]).optional() }),
  z.object({ event: z.literal("sqlite_runtime_setup"), operation_id: z.uuid(), reason_code: z.enum(["execution_interrupted", "runtime_probe_failed"]) }),
  z.object({ event: z.literal("sqlite_service_http"), reason_code: z.literal("service_request_unverified") }),
  z.object({ event: z.literal("sqlite_service_control"), reason_code: z.literal("service_request_unverified") }),
  z.object({ event: z.literal("sqlite_operation_http"), invocation_id: z.uuid(), reason_code: z.literal("operation_unverified") }),
  z.object({ event: z.literal("sqlite_publication_http"), request_id: z.uuid(), job_id: z.uuid(), invocation_id: z.uuid(),
    reason_code: z.enum(["request_conflict", "submission_unverified"]) }),
  z.object({ event: z.literal("sqlite_gateway"), reason_code: z.literal("request_unavailable") }),
  z.object({ event: z.literal("sqlite_operation"), operation_id: z.uuid(), request_id: z.uuid().nullable(), upload_id: z.uuid().nullable(),
    invocation_id: z.uuid(), worker_version_id: z.uuid(), state: operationStateSchema, phase: operationPhaseSchema,
    reason_code: operationReasonSchema.optional() }),
  z.object({ event: z.literal("sqlite_cache_purge"), show_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(32),
    episode_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80).optional(),
    reason_code: z.enum(["purge_rate_limited", "purge_rejected", "purge_unconfirmed"]), attempt: z.number().int().min(1).max(6), will_retry: z.boolean() }),
  z.object({ event: z.literal("sqlite_publication_effect_failed"), job_id: z.uuid(), request_id: z.uuid(),
    phase: z.enum(["show_metadata", "cover", "audio", "revision", "episode_metadata", "feed", "cache_purge"]), reason_code: z.literal("publication_effect_unverified") }),
]);
const frameSchema = z.object({
  outcome: z.string(), eventTimestamp: z.number().finite().nullable().optional(),
  cpuTime: z.number().finite().nonnegative().optional(), wallTime: z.number().finite().nonnegative().optional(),
  truncated: z.boolean().default(false), entrypoint: z.unknown().optional(), durableObjectId: z.unknown().optional(),
  scriptVersion: z.object({ id: z.unknown().optional() }).optional(),
  event: z.object({ entrypoint: z.unknown().optional(), durableObjectId: z.unknown().optional(), scheduledTime: z.union([z.number().finite(), z.iso.datetime()]).optional(),
    request: z.object({ url: z.string(), method: z.string(), headers: z.record(z.string(), z.unknown()).optional() }).optional(),
    response: z.object({ status: z.number().int().min(100).max(599) }).optional(),
    rpcMethod: z.unknown().optional(), methodName: z.unknown().optional() }).nullable().default({}),
  logs: z.array(z.object({ message: z.array(z.unknown()) })).default([]),
  exceptions: z.array(z.unknown()).default([]),
});
export type SqliteInvocationKind = "outer-http" | "cache-http" | "cache-rpc" | "do-alarm" | "do-http" | "do-rpc" | "unknown";
export type SqliteInvocation = {
  at: string; event_timestamp?: number | null; outcome: string; cpu_ms?: number; wall_ms?: number;
  kind: SqliteInvocationKind; entrypoint?: string; has_object_id: boolean; worker_version_id?: string;
  path?: string; method?: string; probe_id?: string; status_request_id?: string; status_read_redacted?: boolean;
  status?: number; truncated: boolean;
  exception_count: number; unrecognized_logs: number; logs: z.infer<typeof diagnosticSchema>[];
};
export class SqliteTailFrameError extends Error {
  constructor(readonly reasonCode: "frame_format_unverified" | "frame_json_unverified" | "frame_schema_unverified", readonly fields: string[] = []) {
    super(`SQLite tail capture was not verified: ${reasonCode}`); this.name = "SqliteTailFrameError";
  }
}

export function sanitizeSqliteInvocation(data: unknown): SqliteInvocation {
  const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) :
    ArrayBuffer.isView(data) ? new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : null;
  if (text === null) throw new SqliteTailFrameError("frame_format_unverified");
  let input: unknown;
  try { input = JSON.parse(text) as unknown; } catch { throw new SqliteTailFrameError("frame_json_unverified"); }
  const parsed = frameSchema.safeParse(input);
  if (!parsed.success) {
    const fields = ["outcome", "eventTimestamp", "cpuTime", "wallTime", "truncated", "scriptVersion", "event.scheduledTime",
      "event.request.url", "event.request.method", "event.request.headers", "event.response", "event", "logs", "exceptions"];
    throw new SqliteTailFrameError("frame_schema_unverified", [...new Set(parsed.error.issues.map((issue) => {
      const path = issue.path.join("."); return fields.find((field) => path === field || path.startsWith(`${field}.`)) ?? "other";
    }))]);
  }
  const raw = parsed.data;
  const event: NonNullable<typeof raw.event> = raw.event ?? {}, request = event.request;
  const logs: SqliteInvocation["logs"] = []; let unrecognizedLogs = 0;
  for (const log of raw.logs) for (const value of log.message) {
    try { const parsed = diagnosticSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value);
      if (parsed.success) logs.push(parsed.data); else unrecognizedLogs++; }
    catch { unrecognizedLogs++; }
  }
  const entrypoint = raw.entrypoint ?? event.entrypoint;
  const hasObjectId = raw.durableObjectId != null || event.durableObjectId != null;
  const method = request && ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"].includes(request.method) ? request.method : undefined;
  const path = request ? new URL(request.url).pathname : undefined;
  const probe = Object.entries(request?.headers ?? {}).find(([key]) => key.toLowerCase() === "x-castloop-probe")?.[1];
  const statusRequest = Object.entries(request?.headers ?? {}).find(([key]) => key.toLowerCase() === "x-castloop-status-request")?.[1];
  const uuid = (value: unknown) => { const parsed = z.uuid().safeParse(value); return parsed.success ? parsed.data : undefined; };
  let kind: SqliteInvocationKind = "unknown";
  if (entrypoint === "SqlitePublicationService" && hasObjectId) kind = event.scheduledTime !== undefined ? "do-alarm" : request ? "do-http" : "do-rpc";
  else if (entrypoint === "SqliteCachedAssets" && !hasObjectId) kind = request ? "cache-http" : "cache-rpc";
  else if (!entrypoint && !hasObjectId && request) kind = "outer-http";
  const safePath = path && (/^\/admin\/sqlite-publication\/(?:status|jobs\/[0-9a-f-]{36})$/.test(path) ||
    /^\/podcasts\/[a-z0-9-]{1,32}\/(?:feed\.xml|cover\.(?:jpg|jpeg|png)|episodes\/[a-z0-9-]{1,80}\/[0-9a-f-]{36}\.mp3)$/.test(path)) ? path : undefined;
  const outcome = ["ok", "canceled", "exception", "exceededCpu", "exceededMemory", "unknown"].includes(raw.outcome) ? raw.outcome : "unknown";
  const statusRead = method === "GET" && path?.startsWith("/admin/sqlite-publication/jobs/") && path.split("/").length === 5;
  let redacted = false;
  if (statusRead) {
    try { const segment = decodeURIComponent(path!.split("/").at(-1)!); redacted = segment.length <= 128 && /redacted/i.test(segment); }
    catch { redacted = false; }
  }
  return { at: new Date().toISOString(), event_timestamp: raw.eventTimestamp, outcome, cpu_ms: raw.cpuTime, wall_ms: raw.wallTime,
    kind, entrypoint: entrypoint === "SqlitePublicationService" || entrypoint === "SqliteCachedAssets" ? entrypoint : undefined,
    has_object_id: hasObjectId, worker_version_id: uuid(raw.scriptVersion?.id), path: safePath, method, probe_id: uuid(probe),
    ...(statusRead && uuid(statusRequest) ? { status_request_id: uuid(statusRequest) } : {}), ...(redacted ? { status_read_redacted: true } : {}),
    status: event.response?.status, truncated: raw.truncated, exception_count: raw.exceptions.length, unrecognized_logs: unrecognizedLogs, logs };
}

export function sqliteStatusReadRequestId(row: SqliteInvocation): string | undefined {
  if (row.kind !== "outer-http" || row.method !== "GET") return undefined;
  const exact = row.path?.match(/^\/admin\/sqlite-publication\/jobs\/([0-9a-f-]{36})$/)?.[1];
  if (exact) return row.status_request_id && row.status_request_id !== exact ? undefined : exact;
  return row.status_read_redacted ? row.status_request_id : undefined;
}

export function classifySqliteInvocation(row: SqliteInvocation): "ok" | "reconcile" | "failed" {
  if (row.truncated || row.exception_count || row.unrecognized_logs || (row.status !== undefined && row.status >= 400) ||
    row.logs.some((log) => log.event === "sqlite_runtime_setup" ||
    log.event === "sqlite_service_http" || log.event === "sqlite_service_control" || log.event === "sqlite_operation_http" ||
    log.event === "sqlite_publication_http" || log.event === "sqlite_gateway" || log.event === "sqlite_publication_effect_failed" ||
    log.event === "sqlite_operation" && ["failed", "blocked"].includes(log.state) ||
    log.event === "sqlite_cache_purge" && !log.will_retry || log.event === "sqlite_publication" && ["failed", "blocked"].includes(log.phase))) return "failed";
  if (row.outcome === "ok") return "ok";
  if (row.outcome === "canceled" && !row.logs.length && !row.unrecognized_logs &&
    (row.kind === "do-alarm" || (row.status === 200 || row.status === undefined) && sqliteStatusReadRequestId(row) !== undefined)) return "reconcile";
  return "failed";
}

type Runtime = { service_id: string; worker_version_id: string; service_config_sha256: string; admission_window_id: string | null;
  completed_update_operation_id?: string };
type Job = { job_id: string; request_id: string; request_sha256: string };
export function verifySqliteObservationCheckpoint(expected: Runtime, healthInput: unknown,
  jobs: Array<{ expected: Job; observed: unknown }>): void {
  const health = sqliteHealthSchema.parse(healthInput);
  const updateVerified = expected.completed_update_operation_id === undefined ? health.runtime_update === null :
    health.runtime_update?.operation_id === expected.completed_update_operation_id && health.runtime_update.state === "completed" &&
    health.runtime_update.new_worker_version_id === expected.worker_version_id;
  if (health.service_id !== expected.service_id || health.worker_version_id !== expected.worker_version_id ||
    health.service_config_sha256 !== expected.service_config_sha256 || health.admission_window_id !== expected.admission_window_id || !health.publication_ready || !health.drained ||
    health.queued !== 0 || health.active !== null || !updateVerified) throw new Error("Observation checkpoint does not prove the exact ready, drained runtime");
  for (const job of jobs) {
    const status = sqlitePublicationStatusSchema.parse(job.observed);
    if (status.service_id !== expected.service_id || status.job_id !== job.expected.job_id || status.request_id !== job.expected.request_id ||
      status.request_sha256 !== job.expected.request_sha256 || status.state !== "succeeded") throw new Error("Observation checkpoint does not prove the exact completed job");
  }
}

export class SqliteObservationGuard {
  private readonly pending = new Set<SqliteInvocation>();
  private failed = false;
  record(row: SqliteInvocation): void {
    const classification = classifySqliteInvocation(row);
    if (classification === "failed") this.failed = true;
    if (classification === "reconcile") this.pending.add(row);
  }
  assertHealthy(): void { if (this.failed) throw new Error("Native invocation or capture failed; preserve all pending operations"); }
  assertCanMutate(): void {
    this.assertHealthy();
    if (this.pending.size) throw new Error("Read-only exact runtime/job reconciliation is required before any new mutation");
  }
  pendingReconciliation(): SqliteInvocation[] { return [...this.pending]; }
  reconcile(rows: SqliteInvocation[], expected: Runtime, health: unknown, jobs: Array<{ expected: Job; observed: unknown }>): void {
    this.assertHealthy();
    if (!rows.length || !jobs.length || rows.some((row) => !this.pending.has(row) || row.worker_version_id !== expected.worker_version_id ||
      row.kind === "outer-http" && !jobs.some((job) => sqliteStatusReadRequestId(row) === job.expected.request_id))) {
      throw new Error("Cancellation evidence differs from the exact runtime");
    }
    verifySqliteObservationCheckpoint(expected, health, jobs);
    for (const row of rows) this.pending.delete(row);
  }
}

export type SqliteCoverage = {
  probes: Array<{ probe_id: string; captured: boolean; matching_frames: number }>;
  jobs: Array<{ job_id: string; started: boolean; succeeded: boolean; alarm_cpu_attribution_verified: false }>;
  missing_probe_cpu: string[]; jobs_missing_logs: string[]; frames_without_expected_version: number;
  capture_complete: boolean; alarm_cpu_attribution_verified: false;
};
export function summarizeSqliteCoverage(rows: SqliteInvocation[], probes: Array<{ id: string }>, jobs: Array<{ job_id: string }>, versionId: string,
  capture: { capture_complete: boolean }): SqliteCoverage {
  const matching = rows.filter((row) => row.worker_version_id === versionId);
  const probeCoverage = probes.map(({ id }) => {
    const frames = matching.filter((row) => row.kind === "outer-http" && row.probe_id === id && typeof row.cpu_ms === "number");
    return { probe_id: id, captured: frames.length === 1 && probes.filter((probe) => probe.id === id).length === 1, matching_frames: frames.length };
  });
  const jobCoverage = jobs.map(({ job_id }) => ({ job_id,
    started: matching.some((row) => row.logs.some((log) => log.event === "sqlite_publication" && log.job_id === job_id && log.phase === "started")),
    succeeded: matching.some((row) => row.logs.some((log) => log.event === "sqlite_publication" && log.job_id === job_id && log.phase === "succeeded")),
    alarm_cpu_attribution_verified: false as const }));
  return { probes: probeCoverage, jobs: jobCoverage, missing_probe_cpu: probeCoverage.filter((probe) => !probe.captured).map((probe) => probe.probe_id),
    jobs_missing_logs: jobCoverage.filter((job) => !job.started || !job.succeeded).map((job) => job.job_id),
    frames_without_expected_version: rows.length - matching.length,
    capture_complete: capture.capture_complete && probeCoverage.every((probe) => probe.captured) && jobCoverage.every((job) => job.started && job.succeeded) &&
      rows.every((row) => row.worker_version_id === versionId && !row.truncated && row.kind !== "unknown"),
    alarm_cpu_attribution_verified: false as const };
}
