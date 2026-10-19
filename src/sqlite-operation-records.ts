import { operationAssetRowSchema, operationCapacitySchema, operationClientSchema, operationCommandHash, operationCommandSchema,
  operationDetailSchema, operationEventRowSchema, operationListSchema, operationReasonSchema, operationRequestRowSchema,
  operationResultSchema, operationRowSchema, operationCleanupPlanSchema } from "../packages/shared/src/sqlite-operations";
import type { OperationAssetRow, OperationClient, OperationCommand, OperationRow, OperationSpec } from "../packages/shared/src/sqlite-operations";
import type { SqlitePublicationRequest, SqlitePublicationRuntime, SqlitePublicationStatus } from "../packages/shared/src/sqlite-publication";
import { sha256Hex } from "../packages/shared/src/sha256";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { OPERATION_DDL } from "./sqlite-operation-schema";

type Reason = ReturnType<typeof operationReasonSchema.parse>;
type Target = OperationSpec | OperationRow;
type RecordedRequest = Pick<OperationCommand, "request_id" | "operation_id" | "expected_version"> & { action: OperationCommand["action"] | "submit_publication" };
export type OperationCleanupBucket = { head: (key: string) => Promise<{ size: number; etag: string; version: string } | null>;
  delete: (key: string) => Promise<void> };
const terminal = (state: string) => ["succeeded", "failed", "cancelled"].includes(state);

export class SqliteOperationRecords {
  constructor(private readonly storage: PublicationQueueStorage, private readonly identity: () => SqlitePublicationRuntime,
    private readonly validateTarget: (target: Target) => boolean = () => true, private readonly now: () => number = Date.now) {
    storage.transactionSync(() => {
      if (storage.sql.exec<{ foreign_keys: number }>("PRAGMA foreign_keys").toArray()[0]?.foreign_keys !== 1) {
        throw new Error("Operation records require SQLite foreign keys");
      }
      const table = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_record_schema'").toArray()[0];
      if (table) {
        if (storage.sql.exec("SELECT version FROM operation_record_schema WHERE id = 1").toArray()[0]?.version !== 1) {
          throw new Error("Unsupported operation record schema; preserve existing records");
        }
      } else for (const statement of OPERATION_DDL.split(";").map((part) => part.trim()).filter(Boolean)) storage.sql.exec(statement);
    });
  }

  capacity() {
    const bytes = this.storage.sql.databaseSize;
    const databaseBytes = typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
    return operationCapacitySchema.parse({ database_bytes: databaseBytes, planning_limit_bytes: 1_000_000_000,
      warning: databaseBytes === null ? "unavailable" : databaseBytes >= 850_000_000 ? "critical" :
        databaseBytes >= 700_000_000 ? "high" : databaseBytes >= 500_000_000 ? "half" : "normal", bytes_per_operation_budget: 20000,
      account_daily_usage: "unknown" });
  }

  get(id: string): OperationRow | null {
    operationCommandSchema.shape.operation_id.parse(id);
    const row = this.storage.sql.exec("SELECT * FROM operations WHERE operation_id = ?", id).toArray()[0];
    return row ? operationRowSchema.parse(row) : null;
  }

  assets(id: string): OperationAssetRow[] {
    return this.storage.sql.exec("SELECT * FROM operation_assets WHERE operation_id = ? OR cleanup_operation_id = ? ORDER BY upload_id LIMIT 2", id, id).toArray().map((row) => operationAssetRowSchema.parse(row));
  }

  list(incomplete: boolean, cursor?: string, parent?: string) {
    if (cursor) operationCommandSchema.shape.operation_id.parse(cursor);
    if (parent) operationCommandSchema.shape.operation_id.parse(parent);
    const anchor = incomplete && cursor ? this.get(cursor) : null;
    if (incomplete && cursor && !anchor) throw new Error("Operation cursor is missing");
    const rows = this.storage.sql.exec(`SELECT * FROM operations WHERE
      ${incomplete ? "state IN ('prepared', 'in_progress', 'blocked') AND (updated_at_ms, operation_id) > (?, ?)" : "operation_id > ?"}
      ${parent ? "AND parent_operation_id = ?" : ""} ORDER BY ${incomplete ? "updated_at_ms, " : ""}operation_id LIMIT 21`,
    ...(incomplete ? [anchor?.updated_at_ms ?? 0, cursor ?? ""] : [cursor ?? ""]), ...(parent ? [parent] : [])).toArray();
    return operationListSchema.parse({ ...this.identity(), schema_version: 1, operations: rows.slice(0, 20),
      next_cursor: rows.length > 20 ? rows[19]!.operation_id : null, capacity: this.capacity() });
  }

  detail(id: string, afterVersion = 0, requestCursor?: string, includeSummary = false) {
    const operation = this.get(id);
    if (!operation) return null;
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0) throw new Error("Invalid event cursor");
    if (requestCursor) operationCommandSchema.shape.request_id.parse(requestCursor);
    const anchor = requestCursor ? this.storage.sql.exec("SELECT received_at_ms FROM operation_requests WHERE operation_id = ? AND request_id = ?", id, requestCursor).toArray()[0] : null;
    if (requestCursor && !anchor) throw new Error("Request cursor belongs to another operation");
    const events = this.storage.sql.exec(`SELECT * FROM operation_events WHERE operation_id = ? AND operation_version > ?
      ORDER BY operation_version LIMIT 21`, id, afterVersion).toArray().map((row) => operationEventRowSchema.parse(row));
    const requests = this.storage.sql.exec(`SELECT * FROM operation_requests WHERE operation_id = ? AND (received_at_ms, request_id) > (?, ?)
      ORDER BY received_at_ms, request_id LIMIT 21`, id, anchor?.received_at_ms ?? 0, requestCursor ?? "").toArray().map((row) => operationRequestRowSchema.parse(row));
    return operationDetailSchema.parse({ ...this.identity(), schema_version: 1, operation, assets: this.assets(id),
      requests: requests.slice(0, 20), events: events.slice(0, 20), next_event_version: events.length > 20 ? events[19]!.operation_version : null,
      next_request_cursor: requests.length > 20 ? requests[19]!.request_id : null, capacity: this.capacity(),
      related_summary: includeSummary && operation.kind === "rss_import" ? this.storage.sql.exec(`SELECT kind, target_kind, state, COUNT(*) AS count
        FROM operations WHERE parent_operation_id = ? GROUP BY kind, target_kind, state`, id).toArray() : [],
      latest_operations: includeSummary && operation.kind === "rss_import" ? this.storage.sql.exec(`SELECT * FROM operations
        WHERE parent_operation_id = ? ORDER BY updated_at_ms DESC, operation_id DESC LIMIT 5`, id).toArray() : [] });
  }

  request(id: string) {
    operationCommandSchema.shape.request_id.parse(id);
    const request = this.storage.sql.exec("SELECT operation_id FROM operation_requests WHERE request_id = ?", id).toArray()[0];
    return request ? this.result({ operation_id: String(request.operation_id), request_id: id }) : null;
  }

  private insertOperation(spec: OperationSpec) {
    const columns = ["operation_id", "parent_operation_id", "import_id", "kind", "target_kind", "show_id", "episode_id", "job_id",
      "worker_version_id", "service_config_sha256", "admission_window_id", "expected_show_state_version",
      "expected_episode_lifecycle_version", "base_revision_id", "base_metadata_sha256", "input_sha256"] as const;
    this.storage.sql.exec(`INSERT INTO operations (${columns.join(", ")}, state, phase, version, created_at_ms, updated_at_ms)
      VALUES (${columns.map(() => "?").join(", ")}, 'prepared', 'prepared', 0, ?, ?)`,
    ...columns.map((key) => spec[key] ?? null), this.now(), this.now());
  }

  private insertRequest(command: RecordedRequest,
    client: OperationClient, hash: string, reason?: Reason) {
    this.storage.sql.exec(`INSERT INTO operation_requests (request_id, operation_id, client_id, cli_version, action,
      request_sha256, expected_version, received_at_ms, outcome, resolved_at_ms, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    command.request_id, command.operation_id, client.client_id, client.cli_version, command.action, hash, command.expected_version,
    this.now(), reason ? "rejected" : "applied", this.now(), reason ?? null);
  }

  private duplicate(command: RecordedRequest,
    client: OperationClient, hash: string): boolean {
    const row = this.storage.sql.exec("SELECT * FROM operation_requests WHERE request_id = ?", command.request_id).toArray()[0];
    if (!row) return false;
    if (row.operation_id !== command.operation_id || row.client_id !== client.client_id || row.cli_version !== client.cli_version ||
      row.action !== command.action || row.expected_version !== command.expected_version || row.request_sha256 !== hash) {
      throw new Error("Operation request identity conflicts with the retained request");
    }
    return true;
  }

  private event(id: string, state: OperationRow["state"], phase: OperationRow["phase"], invocation: string,
    requestId: string | null, uploadId: string | null = null, actor: "client" | "worker" = "client", reason?: Reason) {
    const before = this.get(id)!;
    if (requestId && this.storage.sql.exec("SELECT operation_id FROM operation_requests WHERE request_id = ?", requestId).toArray()[0]?.operation_id !== id) {
      throw new Error("Event request belongs to another operation");
    }
    if (uploadId && !this.storage.sql.exec("SELECT upload_id FROM operation_assets WHERE upload_id = ? AND (operation_id = ? OR cleanup_operation_id = ?)", uploadId, id, id).toArray().length) {
      throw new Error("Event asset belongs to another operation");
    }
    const time = this.now();
    this.storage.sql.exec("UPDATE operations SET state = ?, phase = ?, version = version + 1, updated_at_ms = ?, finished_at_ms = ? WHERE operation_id = ?",
      state, phase, time, terminal(state) ? time : null, id);
    this.storage.sql.exec(`INSERT INTO operation_events (operation_id, operation_version, request_id, upload_id, actor_type,
      invocation_id, worker_version_id, state, phase, recorded_at_ms, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, before.version + 1, requestId, uploadId, actor, invocation, this.identity().worker_version_id, state, phase, time, reason ?? null);
    console.log(JSON.stringify({ event: "sqlite_operation", operation_id: id, request_id: requestId, upload_id: uploadId,
      invocation_id: invocation, worker_version_id: this.identity().worker_version_id, state, phase, ...(reason ? { reason_code: reason } : {}) }));
  }

  private result(command: Pick<OperationCommand, "request_id" | "operation_id">) {
    return operationResultSchema.parse({ ...this.identity(), schema_version: 1, operation: this.get(command.operation_id),
      request: this.storage.sql.exec("SELECT * FROM operation_requests WHERE request_id = ?", command.request_id).toArray()[0] });
  }

  async command(input: OperationCommand, source: OperationClient, invocation = crypto.randomUUID()) {
    const command = operationCommandSchema.parse(input), client = operationClientSchema.parse(source), hash = await operationCommandHash(command);
    return this.storage.transactionSync(() => {
      const runtime = this.identity();
      if (command.service_id !== runtime.service_id || command.worker_version_id !== runtime.worker_version_id ||
        command.service_config_sha256 !== runtime.service_config_sha256) throw new Error("Operation runtime differs");
      if (this.duplicate(command, client, hash)) return this.result(command);
      const operation = this.get(command.operation_id);
      if (!operation) {
        if (command.action !== "register" || command.expected_version !== 0 || !command.operation ||
          ["publication", "cleanup"].includes(command.operation.kind) || !this.validateTarget(command.operation)) throw new Error("Operation registration target differs");
        if (command.operation.kind === "upload" && this.hasPublication(command.operation.job_id!)) throw new Error("Submitted draft uploads are frozen");
        const parent = command.operation.parent_operation_id ? this.get(command.operation.parent_operation_id) : null;
        if (command.operation.parent_operation_id && (!parent || parent.state === "cancelled" || parent.show_id !== command.operation.show_id ||
          parent.import_id !== (command.operation.import_id ?? null))) throw new Error("Operation parent differs");
        const capacity = this.capacity();
        if (command.operation.kind === "rss_import" && capacity.warning === "critical" &&
          (capacity.database_bytes ?? 0) + (command.estimated_operations ?? 1) * 20000 +
          (command.estimated_content_bytes ?? 0) + 10_000_000 > capacity.planning_limit_bytes) {
          throw new Error("Insufficient operation record capacity for this import");
        }
        this.insertOperation(command.operation);
        for (const asset of command.assets ?? []) this.storage.sql.exec(`INSERT INTO operation_assets
          (upload_id, operation_id, asset_kind, object_key, length_bytes, sha256, duration_seconds, upload_state)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared')`, asset.upload_id, command.operation_id, asset.asset, asset.key,
        asset.length_bytes, asset.sha256, asset.duration_seconds ?? null);
        this.insertRequest(command, client, hash);
        this.event(command.operation_id, "prepared", "prepared", invocation, command.request_id);
        return this.result(command);
      }
      let reason: Reason | undefined;
      const assets = this.assets(operation.operation_id), asset = assets.find((entry) => entry.upload_id === command.upload_id);
      if (operation.version !== command.expected_version) reason = "version_conflict";
      else if (operation.worker_version_id !== runtime.worker_version_id || operation.service_config_sha256 !== runtime.service_config_sha256) reason = "runtime_mismatch";
      else if (command.action === "register" || command.action === "cleanup" || operation.kind === "publication" || operation.kind === "cleanup") reason = "state_conflict";
      else if (command.action !== "cancel" && (terminal(operation.state) || !this.validateTarget(operation))) reason = "target_conflict";
      else if (command.action === "begin_upload" && this.hasPublication(operation.job_id!)) reason = "target_conflict";
      else if (command.action === "cancel" && (operation.state === "cancelled" || assets.some((entry) => ["put_requested", "unknown"].includes(entry.upload_state)) ||
        operation.kind === "upload" && this.hasPublication(operation.job_id!) ||
        this.storage.sql.exec("SELECT operation_id FROM operations WHERE parent_operation_id = ? AND state IN ('prepared', 'in_progress', 'blocked') LIMIT 1", operation.operation_id).toArray().length > 0 ||
        ["show_registration", "local_install"].includes(operation.kind) && operation.state !== "prepared")) reason = "state_conflict";
      else if (command.upload_id && (!asset || asset.deletion_state !== "none")) reason = "asset_conflict";
      else if (command.action === "begin_upload" && asset?.upload_state !== "prepared" ||
        command.action === "report_upload" && asset?.upload_state !== "put_requested" ||
        command.action === "verify_upload" && asset?.upload_state !== "put_acknowledged" ||
        command.action === "attach_asset" && asset?.upload_state !== "verified") reason = "state_conflict";
      else if (command.action === "resume" && operation.kind === "upload" && assets.some((entry) => ["put_requested", "unknown"].includes(entry.upload_state))) reason = "state_conflict";
      else if (command.action === "resume" && operation.kind === "upload" && command.phase !== undefined ||
        command.action === "resume" && operation.kind !== "upload" && command.phase === undefined) reason = "state_conflict";
      else if (command.action === "resume" && command.phase === "completed" && operation.kind === "rss_import" &&
        this.storage.sql.exec("SELECT operation_id FROM operations WHERE parent_operation_id = ? AND state IN ('prepared', 'in_progress', 'blocked') LIMIT 1", operation.operation_id).toArray().length) reason = "state_conflict";
      this.insertRequest(command, client, hash, reason);
      if (reason) return this.result(command);
      let phase: OperationRow["phase"] = command.phase ?? operation.phase, state: OperationRow["state"] = "in_progress";
      if (asset) {
        const phases = { begin_upload: "put_requested", report_upload: "put_acknowledged", verify_upload: "verified", attach_asset: "attached" } as const;
        phase = phases[command.action as keyof typeof phases];
        if (command.action === "report_upload") this.storage.sql.exec(`UPDATE operation_assets SET upload_state = 'put_acknowledged',
          put_etag = ?, object_version = ?, put_acknowledged_at_ms = ? WHERE upload_id = ?`, command.receipt!.etag, command.receipt!.version, this.now(), asset.upload_id);
        else {
          const timestamp = command.action === "verify_upload" ? ", verified_at_ms = ?" : command.action === "attach_asset" ? ", attached_at_ms = ?" : "";
          this.storage.sql.exec(`UPDATE operation_assets SET upload_state = ?${timestamp} WHERE upload_id = ?`, phase,
            ...(timestamp ? [this.now()] : []), asset.upload_id);
        }
        if (this.assets(operation.operation_id).every((entry) => entry.upload_state === "attached")) state = "succeeded";
      } else if (command.action === "cancel") {
        phase = "cancelled"; state = "cancelled";
        this.storage.sql.exec("UPDATE operation_assets SET upload_state = 'cancelled' WHERE operation_id = ? AND upload_state = 'prepared'", operation.operation_id);
      } else if (command.phase === "completed") state = "succeeded";
      this.event(operation.operation_id, state, phase, invocation, command.request_id, command.upload_id ?? null);
      return this.result(command);
    });
  }

  private hasPublication(jobId: string) {
    return this.storage.sql.exec("SELECT job_id FROM publication_jobs WHERE job_id = ?", jobId).toArray().length > 0;
  }

  publicationAccepted(request: SqlitePublicationRequest, hash: string, source: OperationClient, invocation: string) {
    const client = operationClientSchema.parse(source);
    const command = { operation_id: request.job_id, request_id: request.request_id, action: "submit_publication" as const, expected_version: 0 };
    if (this.duplicate(command, client, hash)) return;
    this.validatePublicationAssets(request);
    const uploadParent = request.payloads.length ? this.storage.sql.exec(`SELECT o.parent_operation_id, o.import_id FROM operations o
      JOIN operation_assets a ON a.operation_id = o.operation_id WHERE a.upload_id = ?`, request.payloads[0]!.upload_id).toArray()[0] : undefined;
    this.insertOperation({ operation_id: request.job_id, kind: "publication", target_kind: request.kind, show_id: request.show_id,
      episode_id: request.episode_id, job_id: request.job_id, worker_version_id: request.worker_version_id,
      service_config_sha256: request.service_config_sha256, admission_window_id: request.admission_window_id,
      expected_show_state_version: request.expected_show_state_version, expected_episode_lifecycle_version: request.expected_episode_lifecycle_version,
      base_revision_id: request.base_revision_id, input_sha256: hash,
      ...(typeof uploadParent?.parent_operation_id === "string" ? { parent_operation_id: uploadParent.parent_operation_id } : {}),
      ...(typeof uploadParent?.import_id === "string" ? { import_id: uploadParent.import_id } : {}) });
    this.insertRequest(command, client, hash);
    this.event(request.job_id, "in_progress", "queued", invocation, request.request_id);
  }

  requirePublicationClient(request: SqlitePublicationRequest, hash: string, source: OperationClient) {
    if (!this.get(request.job_id)) return;
    if (!this.duplicate({ operation_id: request.job_id, request_id: request.request_id, action: "submit_publication", expected_version: 0 },
      operationClientSchema.parse(source), hash)) throw new Error("Retained publication has no matching operation request");
  }

  validatePublicationAssets(request: SqlitePublicationRequest) {
    for (const upload of request.payloads) {
      const asset = this.storage.sql.exec("SELECT * FROM operation_assets WHERE upload_id = ?", upload.upload_id).toArray()[0];
      if (!asset) continue;
      const operation = this.get(String(asset.operation_id))!;
      if (operation.state !== "succeeded" || operation.job_id !== request.job_id || operation.show_id !== request.show_id ||
        operation.episode_id !== (request.episode_id ?? null) || asset.upload_state !== "attached" || asset.deletion_state !== "none" ||
        asset.object_key !== upload.key || asset.length_bytes !== upload.length_bytes || asset.sha256 !== upload.sha256 ||
        asset.put_etag !== upload.etag || asset.object_version !== upload.version || asset.duration_seconds !== (upload.duration_seconds ?? null)) {
        throw new Error("Publication references an unavailable or different recorded asset");
      }
    }
  }

  publicationChanged(jobId: string, state: SqlitePublicationStatus["state"], reason?: string, invocation = crypto.randomUUID()) {
    const operation = this.get(jobId);
    if (!operation) return;
    const requestId = this.storage.sql.exec("SELECT request_id FROM operation_requests WHERE operation_id = ? AND action = 'submit_publication'", jobId).toArray()[0]?.request_id;
    this.event(jobId, state === "running" || state === "queued" ? "in_progress" : state,
      state === "running" ? "running" : state === "queued" ? "queued" : "completed", invocation,
      typeof requestId === "string" ? requestId : null, null, "worker", reason === undefined ? undefined : operationReasonSchema.parse(reason));
  }

  async cleanupPlan(id: string) {
    const operation = this.get(id);
    if (!operation || operation.kind !== "upload" || operation.state !== "cancelled" || this.hasPublication(operation.job_id!)) {
      throw new Error("Cleanup requires a cancelled upload without a publication request");
    }
    const assets = this.assets(id).filter((asset) => ["put_acknowledged", "verified", "attached"].includes(asset.upload_state) && asset.deletion_state === "none");
    const plan = { ...this.identity(), schema_version: 1 as const, source_operation_id: id, source_version: operation.version, assets };
    return operationCleanupPlanSchema.parse({ ...plan, plan_sha256: await sha256Hex(JSON.stringify(plan)) });
  }

  async cleanup(input: OperationCommand, source: OperationClient, bucket: OperationCleanupBucket, invocation = crypto.randomUUID()) {
    const command = operationCommandSchema.parse(input), client = operationClientSchema.parse(source);
    if (command.action !== "cleanup" || !command.cleanup || command.expected_version !== 0) throw new Error("Invalid cleanup command");
    const hash = await operationCommandHash(command);
    const prior = this.storage.transactionSync(() => this.duplicate(command, client, hash));
    if (prior) return this.result(command);
    const plan = await this.cleanupPlan(command.cleanup.source_operation_id), original = this.get(plan.source_operation_id)!;
    if (plan.plan_sha256 !== command.cleanup.plan_sha256 || plan.source_version !== command.cleanup.source_version || !plan.assets.length) {
      throw new Error("Cleanup preview changed or has no eligible files");
    }
    this.storage.transactionSync(() => {
      const runtime = this.identity(), current = this.get(original.operation_id)!;
      if (command.service_id !== runtime.service_id || command.worker_version_id !== runtime.worker_version_id ||
        command.service_config_sha256 !== runtime.service_config_sha256 || original.worker_version_id !== runtime.worker_version_id ||
        current.version !== plan.source_version || current.state !== "cancelled" || this.hasPublication(original.job_id!) ||
        JSON.stringify(this.assets(original.operation_id).filter((asset) => ["put_acknowledged", "verified", "attached"].includes(asset.upload_state) && asset.deletion_state === "none")) !== JSON.stringify(plan.assets)) {
        throw new Error("Cleanup conditions changed");
      }
      this.insertOperation({ operation_id: command.operation_id, parent_operation_id: original.operation_id,
        ...(original.import_id ? { import_id: original.import_id } : {}), kind: "cleanup", target_kind: original.target_kind,
        show_id: original.show_id, ...(original.episode_id ? { episode_id: original.episode_id } : {}),
        worker_version_id: runtime.worker_version_id, service_config_sha256: runtime.service_config_sha256, input_sha256: plan.plan_sha256 });
      this.insertRequest(command, client, hash);
      this.storage.sql.exec("UPDATE operation_requests SET outcome = 'accepted', resolved_at_ms = NULL WHERE request_id = ?", command.request_id);
      for (const asset of plan.assets) this.storage.sql.exec(`UPDATE operation_assets SET cleanup_operation_id = ?, deletion_state = 'requested'
        WHERE upload_id = ?`, command.operation_id, asset.upload_id);
      this.event(command.operation_id, "in_progress", "cleanup_requested", invocation, command.request_id);
    });
    await this.storage.sync();
    let blocked = false;
    for (const asset of plan.assets) {
      try {
        const requireReserved = () => {
          const runtime = this.identity(), current = this.get(command.operation_id), saved = this.assets(command.operation_id).find((entry) => entry.upload_id === asset.upload_id);
          if (runtime.worker_version_id !== command.worker_version_id || runtime.service_config_sha256 !== command.service_config_sha256 ||
            current?.state !== "in_progress" || saved?.cleanup_operation_id !== command.operation_id || saved.deletion_state !== "requested") {
            throw new Error("Cleanup runtime or reservation changed");
          }
        };
        requireReserved();
        const object = await bucket.head(asset.object_key);
        if (!object || object.etag !== asset.put_etag || object.version !== asset.object_version || object.size !== asset.length_bytes) {
          throw new Error("Cleanup object identity differs");
        }
        requireReserved();
        await bucket.delete(asset.object_key);
        if (await bucket.head(asset.object_key)) throw new Error("Cleanup object remains");
        this.storage.transactionSync(() => {
          requireReserved();
          this.storage.sql.exec("UPDATE operation_assets SET deletion_state = 'deleted', deleted_at_ms = ? WHERE upload_id = ? AND cleanup_operation_id = ?",
            this.now(), asset.upload_id, command.operation_id);
          this.event(command.operation_id, "in_progress", "cleanup_requested", invocation, command.request_id, asset.upload_id, "worker");
        });
        await this.storage.sync();
      } catch {
        blocked = true;
        this.storage.transactionSync(() => {
          this.storage.sql.exec("UPDATE operation_assets SET deletion_state = 'unknown' WHERE upload_id = ? AND cleanup_operation_id = ? AND deletion_state = 'requested'", asset.upload_id, command.operation_id);
          this.event(command.operation_id, "blocked", "cleanup_unknown", invocation, command.request_id, asset.upload_id, "worker", "deletion_unverified");
        });
        break;
      }
    }
    this.storage.transactionSync(() => {
      this.storage.sql.exec("UPDATE operation_requests SET outcome = ?, resolved_at_ms = ? WHERE request_id = ?",
        blocked ? "unknown" : "applied", blocked ? null : this.now(), command.request_id);
      if (!blocked) this.event(command.operation_id, "succeeded", "completed", invocation, command.request_id, null, "worker");
    });
    await this.storage.sync();
    return this.result(command);
  }
}
