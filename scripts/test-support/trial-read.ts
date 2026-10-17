import { BoundedReadError, collectStreamBytes, retryAfterMilliseconds } from "../../packages/cli/src/bounded-http-read";
import { sha256HexSync } from "../../packages/cli/src/sha256";

type Reason = "transport_error" | "observation_timeout" | "http_error" | "partial_response" |
  "missing_body" | "missing_etag" | "size_limit" | "body_read_failed" | "cleanup_failed" | "deadline_exceeded";
export type TrialReadDiagnostic = {
  event: "trial_read"; target_sha256: string; attempt: number; elapsed_ms: number;
  reason_code: Reason; outcome: "retry" | "failed"; http_status?: number; retry_in_ms?: number;
};
export class TrialReadError extends Error {
  constructor(readonly reasonCode: Reason) { super(`Trial observation was not verified: ${reasonCode}`); this.name = "TrialReadError"; }
}
type Options = {
  headers?: HeadersInit; maximumBytes: number; requireEtag?: boolean;
  timeoutMs?: number; attemptTimeoutMs?: number; maximumAttempts?: number;
  onDiagnostic: (value: TrialReadDiagnostic) => void;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number; delay?: (milliseconds: number) => Promise<void>;
};
type Result = { bytes: Uint8Array; headers: Headers; status: number };
class ReadFailure extends Error {
  constructor(readonly code: Reason, readonly retryable: boolean, readonly status?: number, readonly retryAfterMs = 0) { super(code); }
}

async function readAttempt(url: string, options: Options, signal: AbortSignal): Promise<Result> {
  let response: Response;
  const headers = new Headers(options.headers); headers.set("Accept-Encoding", "identity");
  try { response = await (options.transport ?? fetch)(url, { method: "GET", headers,
    redirect: "error", cache: "no-store", signal }); }
  catch { throw new ReadFailure(signal.aborted ? "observation_timeout" : "transport_error", true); }
  const declared = response.headers.get("Content-Length");
  const identityEncoding = !response.headers.has("Content-Encoding") || response.headers.get("Content-Encoding") === "identity";
  try {
    const wait = retryAfterMilliseconds(response);
    if (response.status !== 200) throw new ReadFailure("http_error", [408, 429, 500, 502, 503, 504].includes(response.status), response.status,
      wait !== undefined && Number.isFinite(wait) ? wait : 0);
    if (response.headers.has("Content-Range")) throw new ReadFailure("partial_response", false, response.status);
    if (options.requireEtag && !response.headers.get("ETag")) throw new ReadFailure("missing_etag", false, response.status);
    if (!response.body) throw new ReadFailure("missing_body", false, response.status);
    if (identityEncoding && declared !== null && (!/^\d+$/.test(declared) || Number(declared) > options.maximumBytes)) throw new ReadFailure("size_limit", false, response.status);
  } catch (error) {
    try { await response.body?.cancel(); }
    catch { throw new ReadFailure("cleanup_failed", false, response.status); }
    throw error;
  }
  let bytes: Uint8Array;
  try { bytes = await collectStreamBytes(response.body!, options.maximumBytes); }
  catch (error) {
    if (!(error instanceof BoundedReadError)) throw error;
    throw new ReadFailure(error.code === "body_read_failed" && signal.aborted ? "observation_timeout" : error.code,
      error.code === "body_read_failed", response.status);
  }
  if (identityEncoding && declared !== null && Number(declared) !== bytes.length) throw new ReadFailure("partial_response", false, response.status);
  if (signal.aborted) throw new ReadFailure("observation_timeout", true, response.status);
  return { bytes, headers: response.headers, status: response.status };
}

export async function readTrialObject(url: string, options: Options): Promise<Result> {
  const timeout = options.timeoutMs ?? 30000, attemptTimeout = options.attemptTimeoutMs ?? 10000, maximum = options.maximumAttempts ?? 3;
  if (new URL(url).protocol !== "https:" || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1 ||
    options.maximumBytes > 32_000_000 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000 ||
    !Number.isSafeInteger(attemptTimeout) || attemptTimeout < 1 || attemptTimeout > timeout ||
    !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 3) throw new Error("Invalid bounded trial GET options");
  const now = options.now ?? (() => performance.now()), delay = options.delay ?? ((ms: number) => Bun.sleep(ms));
  const start = now(), target = sha256HexSync(url);
  for (let attempt = 1; attempt <= maximum; attempt++) {
    const remaining = timeout - (now() - start);
    let failure: ReadFailure;
    if (remaining <= 0) failure = new ReadFailure("deadline_exceeded", false);
    else {
      try { return await readAttempt(url, options, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(remaining, attemptTimeout))))); }
      catch (error) { failure = error instanceof ReadFailure ? error : new ReadFailure("body_read_failed", false); }
    }
    const backoff = Math.max(250 * attempt, failure.retryAfterMs);
    const retry = failure.retryable && attempt < maximum && now() - start + backoff < timeout;
    options.onDiagnostic({ event: "trial_read", target_sha256: target, attempt, elapsed_ms: Math.max(0, now() - start),
      reason_code: failure.code, outcome: retry ? "retry" : "failed", ...(failure.status !== undefined ? { http_status: failure.status } : {}),
      ...(retry ? { retry_in_ms: backoff } : {}) });
    if (!retry) throw new TrialReadError(failure.code);
    await delay(backoff);
  }
  throw new TrialReadError("deadline_exceeded");
}
