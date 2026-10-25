import { describe, expect, test } from "bun:test";
import { classifySqliteInvocation, sanitizeSqliteInvocation, sqliteStatusReadRequestId, SqliteObservationGuard, summarizeSqliteCoverage, verifySqliteObservationCheckpoint } from "./sqlite-observability";

const version = "11111111-1111-4111-8111-111111111111", jobId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333", probeId = "44444444-4444-4444-8444-444444444444";
const runtime = { service_id: "trial", worker_version_id: version, service_config_sha256: "a".repeat(64), admission_window_id: requestId };
const health = { ...runtime, protocol: "sqlite-sequential-v1", feed_storage: "immutable-generation-v1", cover_storage: "immutable-generation-v1", publication_read_boundary: "show-episode-v1", feed_generation_allocator: "reservation-v1", domain_changes: "sqlite-domain-change-v1", invocation_id: requestId, publication_ready: true, state: "open",
  availability_controls: "show-admission-delivery-v1", revision_history: "sqlite-revisions-v1", website: "static-show-v1", delivery_statistics: "episode-daily-v1", availability_version: 0, admission_state: "open", delivery_policy: "enabled",
  admission_window_id: requestId, queued: 0, active: null, drained: true, setup: { operation_id: requestId, state: "ready" }, runtime_update: null };
const expected = { job_id: jobId, request_id: requestId, request_sha256: "b".repeat(64) };
const status = { ...expected, service_id: "trial", protocol: "sqlite-sequential-v1", sequence: 1, state: "succeeded" };
const captured = { capture_complete: true };
const frame = (overrides: object = {}) => sanitizeSqliteInvocation(JSON.stringify({ outcome: "ok", cpuTime: 0,
  scriptVersion: { id: version }, event: { request: { url: `https://trial.invalid/admin/sqlite-publication/jobs/${requestId}?token=private`, method: "GET",
    headers: { Authorization: "Bearer private", "X-Castloop-Probe": probeId } }, response: { status: 200 } }, ...overrides }));
const log = (phase = "succeeded") => ({ message: [JSON.stringify({ event: "sqlite_publication", phase, job_id: jobId, request_id: requestId, sequence: 1, private: "never-log" })] });

describe("SQLite trial trace classification", () => {
  test("nullable platform events stay unclassified rather than becoming HTTP measurements", () => {
    const row = frame({ event: null }); expect(row.kind).toBe("unknown");
    expect(summarizeSqliteCoverage([row], [], [], version, captured).capture_complete).toBe(false);
  });
  test("captures safe identity/CPU fields, not queries, headers, object IDs, exceptions, or arbitrary logs", () => {
    const row = frame({ logs: [log(), { message: ["private log", { secret: "private" }] }], exceptions: [{ name: "private", message: "private" }] });
    expect(row.probe_id).toBe(probeId); expect(row.cpu_ms).toBe(0); expect(row.kind).toBe("outer-http");
    expect(row.exception_count).toBe(1); expect(row.unrecognized_logs).toBe(2); expect(row.logs.length).toBe(1);
    expect(JSON.stringify(row)).not.toContain("private"); expect(classifySqliteInvocation(row)).toBe("failed");
  });
  test("allows canceled exact status GET only as a reconciliation candidate, never as success", () => {
    const row = frame({ outcome: "canceled" }); expect(classifySqliteInvocation(row)).toBe("reconcile");
    const guard = new SqliteObservationGuard(); guard.record(row); guard.assertHealthy();
    expect(() => guard.assertCanMutate()).toThrow("reconciliation");
    expect(() => guard.reconcile([row], runtime, { ...health, worker_version_id: jobId }, [{ expected, observed: status }])).toThrow("exact");
    expect(() => guard.reconcile([row], runtime, health, [{ expected, observed: { ...status, request_sha256: "c".repeat(64) } }])).toThrow("exact");
    expect(() => guard.assertCanMutate()).toThrow("reconciliation");
    guard.reconcile([row], runtime, health, [{ expected, observed: status }]); guard.assertCanMutate();
  });
  test("canceled DO Alarm requires native object + explicit Alarm shape", () => {
    const row = frame({ outcome: "canceled", entrypoint: "SqlitePublicationService", durableObjectId: "private", event: { scheduledTime: 1 } });
    expect(row.kind).toBe("do-alarm"); expect(classifySqliteInvocation(row)).toBe("reconcile");
    expect(classifySqliteInvocation(frame({ outcome: "canceled", entrypoint: "SqlitePublicationService", event: { scheduledTime: 1 } }))).toBe("failed");
    const serialized = frame({ outcome: "canceled", entrypoint: "SqlitePublicationService", durableObjectId: "private", event: { scheduledTime: "2026-10-16T11:22:02.000Z" } });
    expect(serialized.kind).toBe("do-alarm"); expect(classifySqliteInvocation(serialized)).toBe("reconcile");
  });
  test("redacted status GET requires an exact request header and completed native reconciliation", () => {
    const row = frame({ outcome: "canceled", event: { request: { url: "https://trial.invalid/admin/sqlite-publication/jobs/[REDACTED]?secret=private", method: "GET",
      headers: { "X-Castloop-Status-Request": requestId, Authorization: "private" } }, response: { status: 200 } } });
    expect(row.path).toBeUndefined(); expect(row.status_read_redacted).toBe(true); expect(row.status_request_id).toBe(requestId);
    expect(sqliteStatusReadRequestId(row)).toBe(requestId); expect(JSON.stringify(row)).not.toContain("private");
    expect(classifySqliteInvocation(row)).toBe("reconcile");
    const guard = new SqliteObservationGuard(); guard.record(row); guard.assertHealthy();
    expect(() => guard.assertCanMutate()).toThrow("reconciliation");
    expect(() => guard.reconcile([row], runtime, health, [])).toThrow();
    expect(() => guard.reconcile([row], runtime, health, [{ expected: { ...expected, request_id: probeId }, observed: status }])).toThrow();
    expect(() => guard.reconcile([row], runtime, health, [{ expected, observed: { ...status, state: "running" } }])).toThrow();
    guard.reconcile([row], runtime, health, [{ expected, observed: status }]); guard.assertCanMutate();
  });
  test("known canceled status reads before response headers remain blocked until reconciliation", () => {
    const row = frame({ outcome: "canceled", event: { request: { url: `https://trial.invalid/admin/sqlite-publication/jobs/${requestId}`, method: "GET",
      headers: { "X-Castloop-Status-Request": requestId } } } });
    expect(row.status).toBeUndefined(); expect(classifySqliteInvocation(row)).toBe("reconcile");
    const guard = new SqliteObservationGuard(); guard.record(row); expect(() => guard.assertCanMutate()).toThrow();
    guard.reconcile([row], runtime, health, [{ expected, observed: status }]); guard.assertCanMutate();
  });
  test("redaction is not permission to adopt an unknown read, mismatched ID or canceled mutation", () => {
    for (const [path, method, headers] of [
      ["[REDACTED]", "GET", {}], ["[REDACTED]", "GET", { "X-Castloop-Status-Request": "private" }],
      [requestId, "GET", { "X-Castloop-Status-Request": jobId }], ["not-a-request", "GET", { "X-Castloop-Status-Request": requestId }],
      ["[REDACTED]", "POST", { "X-Castloop-Status-Request": requestId }],
    ] as Array<[string, string, Record<string, string>]>) {
      const row = frame({ outcome: "canceled", event: { request: { url: `https://trial.invalid/admin/sqlite-publication/jobs/${path}`, method, headers }, response: { status: 200 } } });
      expect(classifySqliteInvocation(row)).toBe("failed");
    }
  });
  test("canceled mutation/other read, truncated frame, exceptions and unrecognized logs stop safely", () => {
    const base = { outcome: "canceled" };
    for (const overrides of [{ event: { request: { url: `https://trial.invalid/admin/sqlite-publication/jobs/${requestId}`, method: "POST" }, response: { status: 200 } } },
      { event: { request: { url: "https://trial.invalid/admin/sqlite-publication/status", method: "GET" }, response: { status: 200 } } },
      { truncated: true }, { exceptions: [{}] }, { logs: [{ message: ["unknown"] }] }, { logs: [log()] }]) {
      expect(classifySqliteInvocation(frame({ ...base, ...overrides }))).toBe("failed");
    }
    const guard = new SqliteObservationGuard(); guard.record(frame({ outcome: "exceededCpu" }));
    expect(() => guard.assertHealthy()).toThrow("failed"); expect(() => guard.reconcile([], runtime, health, [])).toThrow("failed");
  });
  test("rate-limit retry is observable, while permanent/unknown purge failure and effect failure are fatal", () => {
    const purge = { event: "sqlite_cache_purge", show_id: "show", reason_code: "purge_rate_limited", attempt: 1, will_retry: true };
    expect(classifySqliteInvocation(frame({ logs: [{ message: [JSON.stringify(purge)] }] }))).toBe("ok");
    for (const diagnostic of [{ ...purge, will_retry: false }, { event: "sqlite_publication_effect_failed", job_id: jobId, request_id: requestId,
      phase: "feed", reason_code: "publication_effect_unverified" }, { event: "sqlite_service_http", reason_code: "service_request_unverified" }]) {
      expect(classifySqliteInvocation(frame({ logs: [{ message: [JSON.stringify(diagnostic)] }] }))).toBe("failed");
    }
  });
  test("current HTTP diagnostics and error statuses stop mutation even when the platform outcome is ok", () => {
    const diagnostics = [{ event: "sqlite_service_control", reason_code: "service_request_unverified" },
      { event: "sqlite_operation_http", invocation_id: probeId, reason_code: "operation_unverified" }];
    for (const diagnostic of diagnostics) for (const status of [200, 409, 503]) {
      const row = frame({ event: { request: { url: "https://trial.invalid/admin/sqlite-service/health", method: "GET" }, response: { status } },
        logs: [{ message: [{ ...diagnostic, secret: "private" }] }] });
      expect(row.unrecognized_logs).toBe(0); expect(JSON.stringify(row)).not.toContain("private");
      expect(classifySqliteInvocation(row)).toBe("failed");
      const guard = new SqliteObservationGuard(); guard.record(row); expect(() => guard.assertCanMutate()).toThrow("failed");
    }
    for (const status of [401, 404, 409, 503]) expect(classifySqliteInvocation(frame({
      event: { request: { url: "https://trial.invalid/unknown", method: "GET" }, response: { status } } }))).toBe("failed");
    expect(classifySqliteInvocation(frame({ logs: [{ message: [{ event: "unknown", secret: "private" }] }] }))).toBe("failed");
  });
  test("normal current operation logs remain recognized and only failed or blocked states stop the trial", () => {
    const operation = { event: "sqlite_operation", operation_id: jobId, request_id: requestId, upload_id: null,
      invocation_id: probeId, worker_version_id: version, phase: "completed" };
    for (const state of ["prepared", "in_progress", "succeeded", "cancelled", "failed", "blocked"]) {
      const row = frame({ logs: [{ message: [{ ...operation, state, secret: "private" }] }] });
      expect(row.unrecognized_logs).toBe(0); expect(JSON.stringify(row)).not.toContain("private");
      expect(classifySqliteInvocation(row)).toBe(["failed", "blocked"].includes(state) ? "failed" : "ok");
    }
    expect(classifySqliteInvocation(frame({ logs: [log("started"), log()] }))).toBe("ok");
  });
  test("checkpoint rejects blocked, active, unready, update and nonmatching job states", () => {
    for (const invalid of [{ ...health, queued: 1 }, { ...health, active: "blocked", drained: false }, { ...health, publication_ready: false },
      { ...health, service_config_sha256: "f".repeat(64) }]) expect(() => verifySqliteObservationCheckpoint(runtime, invalid, [])).toThrow();
    expect(() => verifySqliteObservationCheckpoint(runtime, health, [{ expected, observed: { ...status, state: "running" } }])).toThrow("exact");
  });
  test("completed compatible updates require their exact operation and new runtime", () => {
    const updated = { ...health, runtime_update: { operation_id: probeId, state: "completed", previous_worker_version_id: jobId, new_worker_version_id: version } };
    expect(() => verifySqliteObservationCheckpoint(runtime, updated, [])).toThrow("exact");
    verifySqliteObservationCheckpoint({ ...runtime, completed_update_operation_id: probeId }, updated, [{ expected, observed: status }]);
    expect(() => verifySqliteObservationCheckpoint({ ...runtime, completed_update_operation_id: requestId }, updated, [])).toThrow("exact");
    expect(() => verifySqliteObservationCheckpoint({ ...runtime, completed_update_operation_id: probeId }, { ...updated,
      runtime_update: { ...updated.runtime_update, state: "activated" } }, [])).toThrow("exact");
  });
});

describe("SQLite measurement coverage", () => {
  test("DO status traces with completion logs never count as outer HTTP or total Alarm CPU", () => {
    const rows = [frame({ entrypoint: "SqlitePublicationService", durableObjectId: "private", cpuTime: 50, logs: [log()] }),
      frame({ entrypoint: "SqliteCachedAssets", cpuTime: 6 }), frame({ entrypoint: "UnknownEntrypoint", cpuTime: 1 })];
    const result = summarizeSqliteCoverage(rows, [{ id: probeId }], [{ job_id: jobId }], version, captured);
    expect(result.missing_probe_cpu).toEqual([probeId]); expect(result.jobs_missing_logs).toEqual([jobId]);
    expect(result.jobs[0]?.succeeded).toBe(true); expect(result.alarm_cpu_attribution_verified).toBe(false); expect(result.capture_complete).toBe(false);
  });
  test("zero CPU is captured; version mismatch, duplicates and missing starts remain explicit", () => {
    const row = frame({ logs: [log("started"), log()] });
    expect(summarizeSqliteCoverage([row], [{ id: probeId }], [{ job_id: jobId }], version, captured)).toMatchObject({ capture_complete: true, missing_probe_cpu: [] });
    expect(summarizeSqliteCoverage([row], [{ id: probeId }], [{ job_id: jobId }], version, { capture_complete: false }).capture_complete).toBe(false);
    for (const rows of [[row, row], [frame({ scriptVersion: { id: jobId } })], [frame({ scriptVersion: {} })]]) {
      expect(summarizeSqliteCoverage(rows, [{ id: probeId }], [], version, captured).capture_complete).toBe(false);
    }
  });
});
