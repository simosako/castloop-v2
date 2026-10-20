import { z } from "zod";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import { operationClientSchema, operationCommandHash, operationCommandSchema, operationDetailSchema, operationListSchema,
  operationResultSchema, operationCleanupPlanSchema, operationSpecSchema } from "../../shared/src/sqlite-operations";
import type { OperationClient, OperationCommand, OperationDetail, OperationResult } from "../../shared/src/sqlite-operations";
import { version } from "../../../package.json";
import { createLocalJournalStorage } from "./local-journal-storage";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { R2RestTransport } from "./verified-r2-put";

const requestJournalSchema = z.object({ schema_version: z.literal(2), show_id: z.string().optional(), command: operationCommandSchema, client: operationClientSchema,
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["prepared", "requested", "confirmed"]), result: operationResultSchema.optional() }).strict();

export function sqliteClientIdentity(root: string, config: SqliteServiceConfig, create = false): OperationClient | null {
  const storage = createLocalJournalStorage(root, "sqlite-client", config.service_id, "client.json");
  try { return { ...operationClientSchema.parse(storage.read()), cli_version: version }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!create) return null;
  try { storage.initialize({ client_id: crypto.randomUUID(), cli_version: version }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { ...operationClientSchema.parse(storage.read()), cli_version: version };
}

export class SqliteOperationClient {
  readonly config: SqliteServiceConfig;
  constructor(input: SqliteServiceConfig, private readonly key: string, private readonly transport: R2RestTransport = fetch,
    private readonly showId?: string) {
    this.config = sqliteServiceConfigSchema.parse(input);
    if (showId !== undefined) operationSpecSchema.shape.show_id.parse(showId);
    if (!key || key.length > 1024 || /[^\x21-\x7e]/.test(key)) throw new Error("Invalid operation management credentials");
  }
  private async requireIdentity<T extends { service_id: string; service_config_sha256: string }>(value: T): Promise<T> {
    if (value.service_id !== this.config.service_id || value.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) {
      throw new Error("Operation response belongs to another service configuration");
    }
    return value;
  }
  private get(path: string, allowMissing = false): Promise<unknown | null> {
    return readSqliteManagementGet(new URL(`/admin/sqlite-operations/${path}`, this.config.workers_dev_base_url),
      { "X-Castloop-Key": this.key, Accept: "application/json", ...(this.showId ? { "X-Castloop-Show-Id": this.showId } : {}) }, { transport: this.transport, maximumBytes: 65536, allowMissing });
  }
  async list(options: { incomplete?: boolean; cursor?: string; parent?: string } = {}) {
    const query = new URLSearchParams({ incomplete: String(options.incomplete ?? false) });
    if (options.cursor) query.set("cursor", z.uuid().parse(options.cursor));
    if (options.parent) query.set("parent", z.uuid().parse(options.parent));
    const result = await this.requireIdentity(operationListSchema.parse(await this.get(`list?${query}`)));
    if (this.showId && result.operations.some((operation) => operation.show_id !== this.showId)) throw new Error("Operation list Show differs");
    return result;
  }
  async detail(id: string, afterVersion = 0, requestCursor?: string, includeSummary = false): Promise<OperationDetail | null> {
    z.uuid().parse(id);
    const query = new URLSearchParams({ after_version: String(afterVersion) });
    if (requestCursor) query.set("request_cursor", z.uuid().parse(requestCursor));
    if (includeSummary) query.set("summary", "true");
    const result = await this.get(`${id}?${query}`, true);
    if (result === null) return null;
    const parsed = await this.requireIdentity(operationDetailSchema.parse(result));
    if (parsed.operation.operation_id !== id || this.showId && parsed.operation.show_id !== this.showId) throw new Error("Operation response target differs");
    return parsed;
  }
  async cleanupPlan(id: string) {
    const plan = await this.requireIdentity(operationCleanupPlanSchema.parse(await this.get(`cleanup/${z.uuid().parse(id)}`)));
    if (plan.source_operation_id !== id) throw new Error("Cleanup target differs");
    return plan;
  }
  async send(root: string, input: OperationCommand): Promise<OperationResult> {
    const command = operationCommandSchema.parse(input);
    const showId = this.showId ?? command.operation?.show_id;
    if (this.showId && command.operation && command.operation.show_id !== this.showId) throw new Error("Operation Show target differs");
    if (command.service_id !== this.config.service_id || command.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) throw new Error("Operation command configuration differs");
    const client = sqliteClientIdentity(root, this.config, true)!;
    const hash = await operationCommandHash(command), storage = createLocalJournalStorage(root, "sqlite-operation-requests", this.config.service_id, `${command.request_id}.json`);
    storage.initialize({ schema_version: 2, ...(showId ? { show_id: showId } : {}), command, client, request_sha256: hash, phase: "prepared" });
    return storage.exclusively(async () => {
      const record = requestJournalSchema.parse(storage.read());
      if (record.show_id !== showId || record.request_sha256 !== hash || JSON.stringify(record.command) !== JSON.stringify(command) ||
        record.client.client_id !== client.client_id) throw new Error("Retained operation request differs");
      if (record.phase === "confirmed") {
        const result = await this.checkedResult(record.result, command, record.client, hash);
        if (result.request.outcome !== "applied") throw new Error("Retained operation request was not applied");
        return result;
      }
      if (record.phase !== "prepared") throw new Error("Operation request result is unknown; inspect its recorded request without resending");
      storage.replace({ ...record, phase: "requested" });
      console.error(JSON.stringify({ event: "sqlite_operation_request", operation_id: command.operation_id,
        request_id: command.request_id, client_id: record.client.client_id }));
      let response: Response | undefined;
      try {
        response = await this.transport(new URL("/admin/sqlite-operations/commands", this.config.workers_dev_base_url), {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { "X-Castloop-Key": this.key,
            ...((this.showId ?? command.operation?.show_id) ? { "X-Castloop-Show-Id": this.showId ?? command.operation!.show_id } : {}),
            "X-Castloop-Client-Id": record.client.client_id, "X-Castloop-Cli-Version": record.client.cli_version,
            "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(command) });
        if (response.status !== 200) throw new Error("Operation request was not acknowledged");
        const result = await this.checkedResult(await readSqliteManagementJson(response, 65536), command, record.client, hash);
        storage.replace({ ...record, phase: "confirmed", result });
        if (result.request.outcome !== "applied") throw new Error(`Operation request ${result.request.outcome}: ${result.request.reason_code ?? "unverified"}`);
        return result;
      } catch {
        throw new Error(`SQLite operation instruction was not verified; inspect operation ${command.operation_id} and request ${command.request_id} without resending`);
      } finally {
        if (response?.body && !response.body.locked) {
          try { await response.body.cancel(); }
          catch { throw new Error("SQLite operation response cleanup failed; preserve its request without resending"); }
        }
      }
    });
  }
  async observeRequest(root: string, command: OperationCommand): Promise<OperationResult | null> {
    const storage = createLocalJournalStorage(root, "sqlite-operation-requests", this.config.service_id, `${command.request_id}.json`);
    const record = requestJournalSchema.parse(storage.read());
    if (record.show_id !== (this.showId ?? command.operation?.show_id)) throw new Error("Frozen operation Show scope differs");
    const hash = await operationCommandHash(command);
    if (record.request_sha256 !== hash || JSON.stringify(record.command) !== JSON.stringify(command)) throw new Error("Frozen operation request differs");
    const value = await this.get(`requests/${command.request_id}`, true);
    return value === null ? null : this.checkedResult(value, command, record.client, hash);
  }
  private async checkedResult(value: unknown, command: OperationCommand, client: OperationClient, hash: string) {
    const result = await this.requireIdentity(operationResultSchema.parse(value));
    if ((this.showId ?? command.operation?.show_id) && result.operation.show_id !== (this.showId ?? command.operation?.show_id)) throw new Error("Operation result Show differs");
    if (result.operation.operation_id !== command.operation_id || result.request.request_id !== command.request_id ||
      result.request.operation_id !== command.operation_id || result.request.client_id !== client.client_id ||
      result.request.cli_version !== client.cli_version || result.request.action !== command.action ||
      result.request.expected_version !== command.expected_version || result.request.request_sha256 !== hash) throw new Error("Operation result differs from the frozen request");
    return result;
  }
  async change(root: string, id: string, action: OperationCommand["action"], fields: Partial<OperationCommand> = {}) {
    const detail = await this.detail(id);
    if (!detail) throw new Error("Operation is not registered");
    return this.send(root, operationCommandSchema.parse({ schema_version: 1, service_id: this.config.service_id,
      worker_version_id: detail.worker_version_id, service_config_sha256: detail.service_config_sha256, operation_id: id,
      request_id: crypto.randomUUID(), expected_version: detail.operation.version, action, ...fields }));
  }
}
