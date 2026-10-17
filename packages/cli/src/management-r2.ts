import { m6ServiceConfigHash, parseServiceConfig, serviceAdmissionSchema, serviceConfigSchema } from "@castloop/shared";
import type { ServiceAdmission, ServiceConfig } from "@castloop/shared";
import { BoundedReadError, collectStreamBytes, retryAfterMilliseconds } from "./bounded-http-read";
import type { StagingRestOptions } from "./staging-rest";
import { sha256HexSync } from "./sha256";

export type ManagementObject = { source: string; etag: string };
export type ManagementReader = { read: (key: string, maximum?: number) => Promise<ManagementObject | null> };

type ReadFailureCode = "http_error" | "transport_error" | "deadline_exceeded" | "missing_body" | "partial_response" |
  "missing_etag" | "body_read_failed" | "size_limit" | "empty_object" | "invalid_utf8" | "response_cleanup_failed" | "invalid_response";
type ResponseEvidence = { http_status?: number; cf_ray?: string; body_present?: boolean;
  etag_present?: boolean; content_range_present?: boolean };
export type ManagementReadDiagnostic = ResponseEvidence & { event: "management_r2_read"; outcome: "retry" | "failed";
  reason_code: ReadFailureCode; key_family: string; key_sha256: string; attempt: number; maximum_attempts: number;
  elapsed_ms: number; retry_after_ms?: number; retry_in_ms?: number };
export type ManagementR2Options = StagingRestOptions & {
  onDiagnostic?: (diagnostic: ManagementReadDiagnostic) => void;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

class ManagementReadFailure extends Error {
  constructor(readonly code: ReadFailureCode, readonly retryable: boolean, readonly evidence: ResponseEvidence = {},
    readonly retryAfterMs?: number) { super(code); }
}

function keyFamily(key: string): string {
  if (key === "system/service.toml") return "service_config";
  if (key === "system/lifecycle-service.json") return "service_admission";
  if (key.startsWith("system/show-publications/")) return "show_control";
  if (key.startsWith("system/show-reservations/")) return "show_reservation";
  if (key.startsWith("system/episode-lifecycle/")) return "episode_lifecycle";
  if (key.startsWith("system/management-requests/")) return "management_request";
  if (key.startsWith("public/episodes/")) return key.includes("/revisions/") ? "episode_revision" : "episode_current";
  return "other_system";
}

async function cancelResponse(response: Response, evidence: ResponseEvidence): Promise<void> {
  try { await response.body?.cancel(); }
  catch { throw new ManagementReadFailure("response_cleanup_failed", false, evidence); }
}

export class ManagementR2Reader implements ManagementReader {
  private readonly config: ServiceConfig;
  constructor(config: ServiceConfig, private readonly options: ManagementR2Options = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  }) {
    this.config = serviceConfigSchema.parse(config);
    if (options.accountId !== this.config.account_id || !options.apiToken || /[\r\n]/.test(options.apiToken)) {
      throw new Error("Private R2 credentials do not match the service account");
    }
  }
  async read(key: string, maximum = 16384): Promise<ManagementObject | null> {
    if (!/^(system|public\/episodes)\//.test(key) || key.split("/").some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) throw new Error("Invalid bounded management record read");
    const timeoutMs = this.options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid management read timeout");
    const now = this.options.now ?? (() => performance.now()), started = now(), deadline = started + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs), maximumAttempts = 3;
    const keyHash = sha256HexSync(key);
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      try {
        if (signal.aborted || now() >= deadline) throw new ManagementReadFailure("deadline_exceeded", false);
        return await this.readAttempt(key, maximum, signal);
      } catch (error) {
        const failure = error instanceof ManagementReadFailure ? error : new ManagementReadFailure("invalid_response", false);
        const waitMs = Math.max(500 * 2 ** (attempt - 1), failure.retryAfterMs ?? 0);
        const retry = failure.retryable && attempt < maximumAttempts && !signal.aborted && waitMs < deadline - now();
        const diagnostic: ManagementReadDiagnostic = { event: "management_r2_read", outcome: retry ? "retry" : "failed",
          reason_code: signal.aborted ? "deadline_exceeded" : failure.code, ...failure.evidence,
          key_family: keyFamily(key), key_sha256: keyHash, attempt, maximum_attempts: maximumAttempts,
          elapsed_ms: Math.max(0, Math.round(now() - started)),
          ...(failure.retryAfterMs !== undefined ? { retry_after_ms: failure.retryAfterMs } : {}),
          ...(retry ? { retry_in_ms: waitMs } : {}) };
        (this.options.onDiagnostic ?? ((record) => console.error(JSON.stringify(record))))(diagnostic);
        if (!retry) throw new Error(`Private R2 management record was not verified [reason_code=${diagnostic.reason_code}, http_status=${diagnostic.http_status ?? "unknown"}, attempt=${attempt}, key_family=${diagnostic.key_family}, key_sha256=${keyHash}${diagnostic.cf_ray ? `, cf_ray=${diagnostic.cf_ray}` : ""}]`);
        await (this.options.delay ?? ((milliseconds) => Bun.sleep(milliseconds)))(waitMs);
      }
    }
    throw new Error("Private R2 management read exhausted its finite attempts");
  }
  private async readAttempt(key: string, maximum: number, signal: AbortSignal): Promise<ManagementObject | null> {
    const config = this.config;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}/r2/buckets/${encodeURIComponent(config.bucket_name)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
    let response: Response;
    try {
      response = await (this.options.transport ?? fetch)(url, { method: "GET", redirect: "error", cache: "no-store", signal,
        headers: { Authorization: `Bearer ${this.options.apiToken}`, "Accept-Encoding": "identity" } });
    } catch { throw new ManagementReadFailure(signal.aborted ? "deadline_exceeded" : "transport_error", !signal.aborted); }
    const ray = response.headers.get("CF-Ray");
    const evidence: ResponseEvidence = { http_status: response.status, body_present: response.body !== null,
      etag_present: !!response.headers.get("ETag"), content_range_present: response.headers.has("content-range"),
      ...(ray && /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(ray) ? { cf_ray: ray } : {}) };
    if (response.status === 404) { await cancelResponse(response, evidence); return null; }
    const reason = response.status !== 200 ? "http_error" : !response.body ? "missing_body" :
      response.headers.has("content-range") ? "partial_response" : !response.headers.get("ETag") ? "missing_etag" : undefined;
    if (reason) {
      const parsedDelay = retryAfterMilliseconds(response);
      const delay = parsedDelay !== undefined && Number.isFinite(parsedDelay) ? parsedDelay : undefined;
      await cancelResponse(response, evidence);
      throw new ManagementReadFailure(reason, [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(response.status), evidence, delay);
    }
    let bytes: Uint8Array;
    try { bytes = await collectStreamBytes(response.body!, maximum, true); }
    catch (error) {
      if (!(error instanceof BoundedReadError)) throw error;
      if (error.code === "size_limit") throw new ManagementReadFailure("size_limit", false, evidence);
      if (error.code === "cleanup_failed") throw new ManagementReadFailure("response_cleanup_failed", false, evidence);
      throw new ManagementReadFailure("body_read_failed", true, evidence);
    }
    if (!bytes.length) throw new ManagementReadFailure("empty_object", false, evidence);
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ManagementReadFailure("invalid_utf8", false, evidence); }
    return { source, etag: response.headers.get("ETag")! };
  }
}

export async function readManagementRuntime(reader: ManagementReader, config: ServiceConfig): Promise<{
  admission: ServiceAdmission; workerVersionId: string; admissionWindowId: string;
}> {
  const before = await reader.read("system/service.toml");
  const object = await reader.read("system/lifecycle-service.json");
  if (!before || !object || await m6ServiceConfigHash(parseServiceConfig(before.source)) !== await m6ServiceConfigHash(config)) {
    throw new Error("Management snapshot has another service configuration");
  }
  const admission = serviceAdmissionSchema.parse(JSON.parse(object.source));
  const readiness = admission.runtime_readiness;
  if (admission.service_id !== config.service_id || admission.mode !== "m6" || !["open", "paused"].includes(admission.state) ||
    admission.url_change || !readiness || readiness.management_protocol !== "queue-management-v1" ||
    readiness.service_config_sha256 !== await m6ServiceConfigHash(config) || !admission.last_resumed_pause_id) {
    throw new Error("Queue management requires verified queue-management-v1 readiness and an explicit resume; update the Worker first");
  }
  const after = await reader.read("system/service.toml");
  if (before.etag !== after?.etag || before.source !== after.source) throw new Error("Service configuration changed during management inspection");
  return { admission, workerVersionId: readiness.worker_version_id, admissionWindowId: admission.last_resumed_pause_id };
}
