import { createHash } from "node:crypto";

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

function retryAfter(response: Response): number {
  const value = response.headers.get("Retry-After");
  if (value === null) return 0;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.ceil(milliseconds)) : 0;
}

async function readAttempt(url: string, options: Options, signal: AbortSignal): Promise<Result> {
  let response: Response;
  const headers = new Headers(options.headers); headers.set("Accept-Encoding", "identity");
  try { response = await (options.transport ?? fetch)(url, { method: "GET", headers,
    redirect: "error", cache: "no-store", signal }); }
  catch { throw new ReadFailure(signal.aborted ? "observation_timeout" : "transport_error", true); }
  const reader = response.body?.getReader();
  let terminal = false;
  try {
    if (response.status !== 200) throw new ReadFailure("http_error", [408, 429, 500, 502, 503, 504].includes(response.status), response.status, retryAfter(response));
    if (response.headers.has("Content-Range")) throw new ReadFailure("partial_response", false, response.status);
    if (options.requireEtag && !response.headers.get("ETag")) throw new ReadFailure("missing_etag", false, response.status);
    if (!reader) throw new ReadFailure("missing_body", false, response.status);
    const declared = response.headers.get("Content-Length");
    const identityEncoding = !response.headers.has("Content-Encoding") || response.headers.get("Content-Encoding") === "identity";
    if (identityEncoding && declared !== null && (!/^\d+$/.test(declared) || Number(declared) > options.maximumBytes)) throw new ReadFailure("size_limit", false, response.status);
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { terminal = true; throw new ReadFailure(signal.aborted ? "observation_timeout" : "body_read_failed", true, response.status); }
      if (chunk.done) { terminal = true; break; }
      length += chunk.value.byteLength;
      if (length > options.maximumBytes) throw new ReadFailure("size_limit", false, response.status);
      chunks.push(chunk.value);
    }
    if (identityEncoding && declared !== null && Number(declared) !== length) throw new ReadFailure("partial_response", false, response.status);
    if (signal.aborted) throw new ReadFailure("observation_timeout", true, response.status);
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, headers: response.headers, status: response.status };
  } finally {
    if (reader) {
      try { if (!terminal) await reader.cancel(); }
      catch { throw new ReadFailure("cleanup_failed", false, response.status); }
      finally { reader.releaseLock(); }
    }
  }
}

export async function readTrialObject(url: string, options: Options): Promise<Result> {
  const timeout = options.timeoutMs ?? 30000, attemptTimeout = options.attemptTimeoutMs ?? 10000, maximum = options.maximumAttempts ?? 3;
  if (new URL(url).protocol !== "https:" || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1 ||
    options.maximumBytes > 32_000_000 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000 ||
    !Number.isSafeInteger(attemptTimeout) || attemptTimeout < 1 || attemptTimeout > timeout ||
    !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 3) throw new Error("Invalid bounded trial GET options");
  const now = options.now ?? (() => performance.now()), delay = options.delay ?? ((ms: number) => Bun.sleep(ms));
  const start = now(), target = createHash("sha256").update(url).digest("hex");
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
