import { MAX_SQLITE_PUBLICATION_BYTES, parseSqlitePublicationRequest, sqlitePublicationRequestHash,
  sqlitePublicationStatusSchema, sqliteServiceConfigHash, sqliteServiceConfigSchema, sqliteServiceStatusSchema } from "@castloop/shared";
import type { SqlitePublicationRequest, SqlitePublicationStatus, SqliteServiceConfig, SqliteServiceStatus } from "@castloop/shared";
import type { R2RestTransport } from "./verified-r2-put";

export async function readSqliteManagementJson(response: Response): Promise<unknown> {
  if (!response.body || response.headers.get("Cache-Control") !== "no-store" || response.headers.has("Content-Range") ||
    response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
    await response.body?.cancel();
    throw new Error("SQLite management response is not bounded non-cacheable JSON");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_SQLITE_PUBLICATION_BYTES) throw new Error("SQLite management response exceeds its limit");
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

export class SqlitePublicationClient {
  readonly config: SqliteServiceConfig;
  constructor(input: SqliteServiceConfig, private readonly administratorKey: string,
    private readonly transport: R2RestTransport = fetch, private readonly timeoutMs = 30000) {
    this.config = sqliteServiceConfigSchema.parse(input);
    if (!administratorKey || administratorKey.length > 1024 || /[^\x21-\x7e]/.test(administratorKey) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid SQLite management credentials or timeout");
  }

  private async call(path: string, input?: SqlitePublicationRequest): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.transport(new URL(`/admin/sqlite-publication/${path}`, this.config.workers_dev_base_url), {
        method: input ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "X-Castloop-Key": this.administratorKey, "Accept": "application/json",
          ...(input ? { "Content-Type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}),
      });
    } catch { throw new Error("SQLite management response is unknown; preserve the request without automatic retry"); }
    if (!input && path.startsWith("jobs/") && response.status === 404 && response.headers.get("Cache-Control") === "no-store") {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== (input ? 202 : 200)) {
      await response.body?.cancel();
      throw new Error(`SQLite management request was not verified (HTTP ${response.status}); no automatic retry`);
    }
    try { return await readSqliteManagementJson(response); }
    catch { throw new Error("SQLite management response body was not verified; preserve the request without automatic retry"); }
  }

  async describe(): Promise<SqliteServiceStatus> {
    const parsed = sqliteServiceStatusSchema.safeParse(await this.call("status"));
    if (!parsed.success) throw new Error("SQLite management capability was not verified");
    const status = parsed.data;
    if (status.service_id !== this.config.service_id || status.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) {
      throw new Error("SQLite management runtime belongs to another service configuration");
    }
    return status;
  }

  private async requireRequest(input: SqlitePublicationRequest): Promise<SqlitePublicationRequest> {
    const request = parseSqlitePublicationRequest(input);
    if (request.service_id !== this.config.service_id || request.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) {
      throw new Error("SQLite publication request belongs to another service configuration");
    }
    return request;
  }

  private async result(value: unknown, request: SqlitePublicationRequest): Promise<SqlitePublicationStatus> {
    const parsed = sqlitePublicationStatusSchema.safeParse(value);
    if (!parsed.success) throw new Error("SQLite publication result schema was not verified");
    const status = parsed.data;
    if (status.service_id !== request.service_id || status.request_id !== request.request_id || status.job_id !== request.job_id ||
      status.request_sha256 !== await sqlitePublicationRequestHash(request)) throw new Error("SQLite publication result differs from its frozen request");
    return status;
  }

  async submit(input: SqlitePublicationRequest): Promise<SqlitePublicationStatus> {
    const request = await this.requireRequest(input);
    return this.result(await this.call("jobs", request), request);
  }

  async observe(input: SqlitePublicationRequest): Promise<SqlitePublicationStatus | null> {
    const request = await this.requireRequest(input);
    const value = await this.call(`jobs/${request.request_id}`);
    return value === null ? null : this.result(value, request);
  }
}
