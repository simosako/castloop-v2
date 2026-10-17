import type { R2RestTransport } from "./verified-r2-put";
import { BoundedReadError, collectStreamBytes, retryAfterMilliseconds } from "./bounded-http-read";
import { sha256HexSync } from "./sha256";

type ReadFailureCode = "transport_error" | "observation_timeout" | "http_error" | "invalid_response" |
  "body_read_failed" | "length_mismatch" | "size_limit" | "invalid_utf8" | "invalid_json" | "cleanup_failed" | "deadline_exceeded";
export type SqliteManagementReadDiagnostic = { event: "sqlite_management_get"; outcome: "retry" | "failed";
  reason_code: ReadFailureCode; target_sha256: string; attempt: number; maximum_attempts: number; elapsed_ms: number;
  http_status?: number; retry_in_ms?: number };
export type SqliteManagementReadBudget = { beforeAttempt?: () => boolean };
export type SqliteManagementReadOptions = SqliteManagementReadBudget & { onDiagnostic?: (diagnostic: SqliteManagementReadDiagnostic) => void;
  now?: () => number; delay?: (milliseconds: number) => Promise<void> };
type GetOptions = SqliteManagementReadOptions & { transport?: R2RestTransport; timeoutMs?: number; maximumBytes?: number; allowMissing?: boolean };

class ReadFailure extends Error {
  constructor(readonly code: ReadFailureCode, readonly retryable: boolean, readonly status?: number, readonly retryAfterMs = 0) { super(code); }
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { throw new ReadFailure("cleanup_failed", false); }
}

export async function readSqliteManagementJson(response: Response, maximum = 16384, signal?: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65536) throw new Error("Invalid SQLite response limit");
  if (!response.body || response.headers.get("Cache-Control") !== "no-store" || response.headers.has("Content-Range") ||
    response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
    await cancelBody(response); throw new ReadFailure("invalid_response", false);
  }
  const declared = response.headers.get("Content-Length"), encoding = response.headers.get("Content-Encoding");
  const compareLength = encoding === null || encoding === "identity";
  try {
    if (compareLength && declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new ReadFailure("invalid_response", false);
    if (compareLength && declared !== null && Number(declared) > maximum) throw new ReadFailure("size_limit", false);
  } catch (error) {
    await cancelBody(response); throw error;
  }
  let bytes: Uint8Array;
  try { bytes = await collectStreamBytes(response.body, maximum); }
  catch (error) {
    if (!(error instanceof BoundedReadError)) throw error;
    throw new ReadFailure(error.code === "body_read_failed" && signal?.aborted ? "observation_timeout" : error.code,
      error.code === "body_read_failed");
  }
  if (signal?.aborted) throw new ReadFailure("observation_timeout", true);
  if (compareLength && declared !== null && Number(declared) !== bytes.length) throw new ReadFailure("length_mismatch", true);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ReadFailure("invalid_utf8", false); }
  try { return JSON.parse(source) as unknown; } catch { throw new ReadFailure("invalid_json", false); }
}

function readPath(path: string): boolean {
  if (["/admin/sqlite-service/health", "/admin/sqlite-publication/status"].includes(path)) return true;
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (new RegExp(`^/admin/(?:sqlite-publication/jobs|sqlite-service/update-status)/${uuid}$`, "i").test(path)) return true;
  const parts = path.slice("/admin/sqlite-service/targets/".length).split("/");
  return path.startsWith("/admin/sqlite-service/targets/") && parts.length >= 1 && parts.length <= 2 &&
    parts.every((part, index) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part) && part.length <= (index === 0 ? 32 : 80));
}

export async function readSqliteManagementGet(url: URL, headers: HeadersInit, options: GetOptions = {}): Promise<unknown | null> {
  const timeout = options.timeoutMs ?? 30000, maximum = options.maximumBytes ?? 16384, attempts = 3;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !readPath(url.pathname) ||
    !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65536) throw new Error("Invalid bounded SQLite management GET");
  const now = options.now ?? (() => performance.now()), delay = options.delay ?? ((ms: number) => Bun.sleep(ms));
  const start = now(), deadline = start + timeout, target = sha256HexSync(url.href);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - now();
    let failure: ReadFailure;
    if (remaining <= 0 || options.beforeAttempt && !options.beforeAttempt()) failure = new ReadFailure("deadline_exceeded", false);
    else {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.ceil(Math.min(10000, remaining))));
      try {
        let response: Response;
        try { response = await (options.transport ?? fetch)(url, { method: "GET", headers, redirect: "error", cache: "no-store", signal: controller.signal }); }
        catch { throw new ReadFailure(controller.signal.aborted ? "observation_timeout" : "transport_error", true); }
        if (options.allowMissing && response.status === 404 && response.headers.get("Cache-Control") === "no-store" && !response.headers.has("Content-Range")) {
          await cancelBody(response); return null;
        }
        if (response.status !== 200) {
          const wait = retryAfterMilliseconds(response) ?? 0;
          await cancelBody(response);
          throw new ReadFailure("http_error", [408, 429, 500, 502, 503, 504].includes(response.status), response.status, wait);
        }
        const value = await readSqliteManagementJson(response, maximum, controller.signal);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadFailure("invalid_response", false);
        if (now() >= deadline) throw new ReadFailure("deadline_exceeded", false);
        return value;
      } catch (error) { failure = error instanceof ReadFailure ? error : new ReadFailure("invalid_response", false); }
      finally { clearTimeout(timer); }
    }
    const backoff = Math.max(250 * attempt, failure.retryAfterMs);
    const retry = failure.retryable && attempt < attempts && Number.isFinite(backoff) && backoff < deadline - now();
    const diagnostic: SqliteManagementReadDiagnostic = { event: "sqlite_management_get", outcome: retry ? "retry" : "failed",
      reason_code: failure.code, target_sha256: target, attempt, maximum_attempts: attempts, elapsed_ms: Math.max(0, Math.round(now() - start)),
      ...(failure.status === undefined ? {} : { http_status: failure.status }), ...(retry ? { retry_in_ms: backoff } : {}) };
    (options.onDiagnostic ?? ((row) => console.error(JSON.stringify(row))))(diagnostic);
    if (!retry) throw new Error(`SQLite management GET was not verified [reason_code=${failure.code}, attempt=${attempt}, http_status=${failure.status ?? "unknown"}]; preserve the frozen request`);
    await delay(backoff);
  }
  throw new Error("SQLite management GET exhausted its finite attempts");
}
