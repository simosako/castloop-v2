import { parseSqliteDomainRequest, sqliteDomainActivationSchema, sqliteDomainFinalizeSchema,
  sqliteDomainRequestHash, sqliteDomainServiceStatusSchema, sqliteDomainStateSchema } from "../../shared/src/sqlite-domain";
import type { SqliteDomainActivation, SqliteDomainFinalize, SqliteDomainRequest } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteHealthSchema } from "../../shared/src/sqlite-service-api";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { R2RestTransport } from "./verified-r2-put";

export class SqliteDomainClient {
  readonly config: SqliteServiceConfig;
  constructor(config: SqliteServiceConfig, private readonly key: string, private readonly transport: R2RestTransport = fetch) {
    this.config = sqliteServiceConfigSchema.parse(config);
    if (!key || /[^\x21-\x7e]/.test(key) || key.length > 1024) throw new Error("Missing domain administrator key");
  }
  private async call(path: string, body?: object): Promise<unknown> {
    const url = new URL(`/admin/sqlite-service/${path}`, this.config.workers_dev_base_url);
    if (!body) return readSqliteManagementGet(url, { "X-Castloop-Key": this.key }, { transport: this.transport });
    let response: Response;
    try {
      response = await this.transport(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), cache: "no-store",
        headers: { "X-Castloop-Key": this.key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch { throw new Error("Domain management request outcome is unknown; preserve its journal without replay"); }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error("Domain management response was not verified; preserve its journal"); }
    return readSqliteManagementJson(response);
  }
  async state() {
    const result = sqliteDomainStateSchema.parse(await this.call("domain-state"));
    if (result.runtime.service_id !== this.config.service_id) throw new Error("Domain state belongs to another service");
    return result;
  }
  async nativeHealth() {
    const result = sqliteHealthSchema.parse(await this.call("registration-health"));
    if (result.service_id !== this.config.service_id || result.scope !== "service") throw new Error("Domain native health belongs to another service");
    return result;
  }
  async status(request: SqliteDomainRequest, after = "") {
    const expected = await parseSqliteDomainRequest(request);
    return this.verify(await this.call(`domain-status/${expected.operation_id}${after ? `?after=${encodeURIComponent(after)}` : ""}`), expected);
  }
  private async verify(input: unknown, expected: SqliteDomainRequest) {
    const result = sqliteDomainServiceStatusSchema.parse(input);
    if (JSON.stringify(result.own.request) !== JSON.stringify(expected) || result.own.request_sha256 !== await sqliteDomainRequestHash(expected) ||
      result.own.actual_runtime.service_id !== expected.previous_runtime.service_id ||
      result.phase !== "completed" && ![expected.previous_runtime.service_config_sha256, expected.target_config_sha256].includes(result.own.actual_runtime.service_config_sha256)) throw new Error("Domain response differs from its frozen request");
    if (result.phase !== "completed" && (!result.own.paused || !result.own.drained)) throw new Error("Domain maintenance is not paused and drained");
    return result;
  }
  async prepare(input: SqliteDomainRequest) {
    const request = await parseSqliteDomainRequest(input);
    const result = await this.verify(await this.call("domain-prepare", request), request);
    if (result.phase !== "prepared" || result.own.phase !== "prepared" || result.prepared_count !== result.target_count ||
      JSON.stringify(result.own.actual_runtime) !== JSON.stringify(request.previous_runtime)) throw new Error("Domain preparation result differs");
    return result;
  }
  async activate(input: SqliteDomainActivation, request: SqliteDomainRequest) {
    const activation = sqliteDomainActivationSchema.parse(input);
    const result = await this.verify(await this.call("domain-activate", activation), request);
    if (JSON.stringify(result.own.activation) !== JSON.stringify(activation)) throw new Error("Domain activation receipt differs");
    return result;
  }
  async finalize(input: SqliteDomainFinalize, request: SqliteDomainRequest) {
    const finalized = sqliteDomainFinalizeSchema.parse(input);
    const result = await this.verify(await this.call("domain-finalize", finalized), request);
    if (result.phase !== "completed" || !result.all_completed || result.released_count !== result.target_count) throw new Error("Domain finalization was not verified");
    return result;
  }
}
