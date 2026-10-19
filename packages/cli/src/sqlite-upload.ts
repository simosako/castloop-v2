import { z } from "zod";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema, sqliteUploadKey, sqliteVerifiedUploadSchema } from "@castloop/shared";
import type { SqliteServiceConfig, StagePayload } from "@castloop/shared";
import { operationAssetIntentSchema, operationCommandSchema } from "../../shared/src/sqlite-operations";
import type { OperationCommand } from "../../shared/src/sqlite-operations";
import { sqliteDraftAssetSchema, sqliteDraftTargetSchema } from "./sqlite-draft-journal";
import type { SqliteDraftAsset, SqliteDraftTarget } from "./sqlite-draft-journal";
import { createLocalJournalStorage } from "./local-journal-storage";
import { ensureLocalJournalParents } from "./local-journal-path";
import { assertLocalStagingSource, freezePayloadSources } from "./staging-sources";
import { putVerifiedR2Object, requireR2RestOptions, verifyAcknowledgedR2Object } from "./verified-r2-put";
import type { R2RestOptions } from "./verified-r2-put";
import { SqliteOperationClient } from "./sqlite-operation-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import { sha256HexSync as sha256 } from "./sha256";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const contentTypes = { show_metadata: "application/toml", episode_metadata: "application/toml",
  cover_jpg: "image/jpeg", cover_png: "image/png", audio: "audio/mpeg" };
const intentSchema = z.object({ ...operationAssetIntentSchema.shape, source_path: z.string().min(1).max(2048),
  state: z.enum(["prepared", "put_requested", "put_acknowledged", "verified", "attached"]),
  receipt: z.object({ etag: sqliteVerifiedUploadSchema.shape.etag, version: sqliteVerifiedUploadSchema.shape.version }).strict().optional(),
}).strict();
export const sqliteUploadRecordSchema = z.object({ schema_version: z.literal(2), protocol: z.literal("sqlite-sequential-v1"),
  operation_id: z.uuid(), service_id: z.string(), service_config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  target: sqliteDraftTargetSchema, registration: operationCommandSchema, base_assets: z.array(sqliteDraftAssetSchema).max(2),
  metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/), intents: z.array(intentSchema).min(1).max(2), pending: operationCommandSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.registration.operation_id !== value.operation_id || value.registration.action !== "register" || value.registration.operation?.kind !== "upload" ||
    value.registration.operation.job_id !== value.target.job_id || value.registration.operation.show_id !== value.target.show_id ||
    value.registration.operation.episode_id !== value.target.episode_id || value.registration.service_id !== value.service_id ||
    value.registration.service_config_sha256 !== value.service_config_sha256 || value.pending && value.pending.operation_id !== value.operation_id ||
    value.intents.some((intent) => (intent.state === "prepared" || intent.state === "put_requested") !== (intent.receipt === undefined)) ||
    JSON.stringify(value.registration.assets) !== JSON.stringify(value.intents.map(({ source_path, state, receipt, ...asset }) => asset))) {
    context.addIssue({ code: "custom", message: "Upload checkpoint differs from its frozen operation" });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 16384) context.addIssue({ code: "custom", message: "Upload checkpoint exceeds its journal limit" });
});
export type SqliteUploadRecord = z.infer<typeof sqliteUploadRecordSchema>;
export type SqliteUploadTracking = { client: SqliteOperationClient; service: SqliteServiceClient; metadataSha256: string;
  baseAssets: SqliteDraftAsset[]; parentOperationId?: string; importId?: string; onUploadPrepared?: (id: string) => void };

export async function readSqliteUploadRecord(root: string, config: SqliteServiceConfig, id: string): Promise<SqliteUploadRecord> {
  const record = sqliteUploadRecordSchema.parse(createLocalJournalStorage(root, "sqlite-uploads", config.service_id, `${z.uuid().parse(id)}.json`).read());
  if (record.operation_id !== id || record.service_id !== config.service_id || record.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
    throw new Error("Upload operation belongs to another service or configuration");
  }
  return record;
}

export async function requireNoPendingSqliteUpload(root: string, config: SqliteServiceConfig, target: SqliteDraftTarget, client: SqliteOperationClient) {
  ensureLocalJournalParents(root, "sqlite-uploads", config.service_id);
  let names: string[];
  try { names = readdirSync(join(root, ".castloop", "sqlite-uploads", config.service_id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (names.length > 10000) throw new Error("Inspect retained uploads before adding more local records");
  for (const name of names.filter((entry) => /^[0-9a-f-]{36}\.json$/i.test(entry))) {
    const value = createLocalJournalStorage(root, "sqlite-uploads", config.service_id, name).read();
    if (!value || typeof value !== "object" || !("schema_version" in value) || value.schema_version !== 2) continue;
    const record = sqliteUploadRecordSchema.parse(value);
    if (record.target.job_id !== target.job_id || record.intents.every((asset) => asset.state === "attached")) continue;
    const remote = await client.detail(record.operation_id);
    if (remote?.operation.state !== "cancelled") throw new Error(`Resume or inspect the unfinished upload operation ${record.operation_id} before replacing it`);
  }
}

export async function uploadSqliteDraftAssets(root: string, input: SqliteServiceConfig, target: SqliteDraftTarget,
  payloads: readonly StagePayload[], paths: readonly string[], duration: number | undefined,
  options: R2RestOptions, tracking: SqliteUploadTracking): Promise<{ assets: SqliteDraftAsset[]; operationId: string }> {
  const config = sqliteServiceConfigSchema.parse(input);
  requireR2RestOptions(config.account_id, options);
  const sources = await freezePayloadSources(root, payloads, paths);
  try {
    const intents = sources.payloads.map((payload, index) => {
      const uploadId = crypto.randomUUID();
      return { ...payload, upload_id: uploadId, key: sqliteUploadKey({ show_id: target.show_id,
        draft_job_id: target.job_id, upload_id: uploadId, asset: payload.asset }), source_path: resolve(root, paths[index]!),
        ...(payload.asset === "audio" ? { duration_seconds: duration } : {}) };
    });
    for (const { source_path, ...intent } of intents) {
      sqliteDraftAssetSchema.parse({ source_path, upload: { ...intent, verified: true, etag: "preflight", version: "preflight" } });
    }
    const operationId = crypto.randomUUID(), service = await tracking.service.inspect(target.show_id, target.episode_id);
    if (!service.publication_ready || service.state !== "open" || !service.admission_window_id || service.expected_show_state_version !== target.expected_show_state_version ||
      service.base_revision_id !== target.base_revision_id || (service.expected_episode_lifecycle_version ?? 0) !== (target.expected_episode_lifecycle_version ?? 0)) throw new Error("Upload target changed before registration");
    const configHash = await sqliteServiceConfigHash(config), assets = intents.map(({ source_path, ...intent }) => intent);
    const registration = operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id,
      worker_version_id: service.worker_version_id, service_config_sha256: configHash, operation_id: operationId,
      request_id: crypto.randomUUID(), expected_version: 0, action: "register", assets,
      operation: { operation_id: operationId, kind: "upload", target_kind: target.kind, show_id: target.show_id,
        episode_id: target.episode_id, job_id: target.job_id, expected_show_state_version: target.expected_show_state_version,
        expected_episode_lifecycle_version: target.expected_episode_lifecycle_version, base_revision_id: target.base_revision_id,
        base_metadata_sha256: target.base_metadata_sha256, worker_version_id: service.worker_version_id, service_config_sha256: configHash,
        admission_window_id: service.admission_window_id, parent_operation_id: tracking.parentOperationId, import_id: tracking.importId,
        input_sha256: sha256(JSON.stringify({ target, assets, base_assets: tracking.baseAssets, metadata_sha256: tracking.metadataSha256 })) } });
    const storage = createLocalJournalStorage(root, "sqlite-uploads", config.service_id, `${operationId}.json`);
    const record = sqliteUploadRecordSchema.parse({ schema_version: 2, protocol: "sqlite-sequential-v1", operation_id: operationId,
      service_id: config.service_id, service_config_sha256: configHash, target, registration, base_assets: tracking.baseAssets,
      metadata_sha256: tracking.metadataSha256, intents: intents.map((intent) => ({ ...intent, state: "prepared" })) });
    if (Buffer.byteLength(JSON.stringify(record)) > 16384) throw new Error("SQLite upload journal exceeds its limit");
    sqliteUploadRecordSchema.parse({ ...record, pending: registration, intents: record.intents.map((intent) => ({ ...intent,
      state: "put_acknowledged", receipt: { etag: "e".repeat(128), version: "v".repeat(128) } })) });
    storage.initialize(record);
    if (JSON.stringify(storage.read()) !== JSON.stringify(record)) throw new Error("Preserve the different SQLite upload attempt");
    tracking.onUploadPrepared?.(operationId);
    console.error(JSON.stringify({ event: "sqlite_upload_started", operation_id: operationId, job_id: target.job_id }));
    return await runSqliteUpload(root, config, operationId, options, tracking.client, sources, true);
  } finally { await sources.dispose(); }
}

export async function resumeSqliteUpload(root: string, config: SqliteServiceConfig, id: string, options: R2RestOptions, client: SqliteOperationClient) {
  const record = await readSqliteUploadRecord(root, config, id);
  for (const intent of record.intents) await assertLocalStagingSource(intent.source_path,
    { asset: intent.asset, length_bytes: intent.length_bytes, sha256: intent.sha256 });
  const sources = await freezePayloadSources(root, record.intents.map(({ asset, length_bytes, sha256 }) => ({ asset, length_bytes, sha256 })), record.intents.map((asset) => asset.source_path));
  try { return await runSqliteUpload(root, config, id, options, client, sources, false); }
  finally { await sources.dispose(); }
}

async function runSqliteUpload(root: string, config: SqliteServiceConfig, id: string, options: R2RestOptions,
  client: SqliteOperationClient, sources: Awaited<ReturnType<typeof freezePayloadSources>>, initial: boolean) {
  const storage = createLocalJournalStorage(root, "sqlite-uploads", config.service_id, `${id}.json`);
  return storage.exclusively(async () => {
    let record = await readSqliteUploadRecord(root, config, id);
    const save = () => { sqliteUploadRecordSchema.parse(record); storage.replace(record); };
    const send = async (command: OperationCommand) => {
      record = { ...record, pending: command }; save();
      const result = await client.send(root, command);
      record = { ...record, pending: undefined }; save(); return result;
    };
    if (record.pending) {
      const result = await client.observeRequest(root, record.pending);
      if (!result || result.request.outcome !== "applied") throw new Error("Upload instruction remains unknown or was rejected; preserve its checkpoint");
      record = { ...record, pending: undefined }; save();
    }
    const change = async (action: OperationCommand["action"], fields: Partial<OperationCommand> = {}) => {
      const remote = await client.detail(id);
      if (!remote) throw new Error("Upload operation is missing");
      return send(operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id, worker_version_id: remote.worker_version_id,
        service_config_sha256: remote.service_config_sha256, operation_id: id, request_id: crypto.randomUUID(),
        expected_version: remote.operation.version, action, ...fields }));
    };
    if (initial) await send(record.registration);
    else {
      const remote = await client.detail(id);
      if (!remote || remote.operation.input_sha256 !== record.registration.operation!.input_sha256 || remote.operation.state === "cancelled") throw new Error("Upload registration is missing, changed or cancelled");
      if (record.intents.some((asset) => asset.state === "put_requested")) throw new Error("PUT outcome is unknown; the upload will not be repeated");
      if (remote.operation.state !== "succeeded") await change("resume");
    }
    for (const [index, intent] of record.intents.entries()) {
      const target = { key: intent.key, length: intent.length_bytes, sha256: intent.sha256, contentType: contentTypes[intent.asset] };
      if (intent.state === "prepared") {
        await change("begin_upload", { upload_id: intent.upload_id });
        intent.state = "put_requested"; save();
        await sources.withPayload(index, async (body, requireConsumed) => {
          await putVerifiedR2Object(config, target, body, requireConsumed, options, async (receipt) => {
            intent.receipt = receipt; intent.state = "put_acknowledged"; save();
            await change("report_upload", { upload_id: intent.upload_id, receipt });
          });
        });
        intent.state = "verified"; save();
      } else if (intent.state === "put_acknowledged") {
        const remote = (await client.detail(id))!.assets.find((asset) => asset.upload_id === intent.upload_id);
        if (!remote) throw new Error("Upload asset record is missing");
        if (remote.upload_state === "put_requested") await change("report_upload", { upload_id: intent.upload_id, receipt: intent.receipt });
        else if (remote.put_etag !== intent.receipt!.etag || remote.object_version !== intent.receipt!.version) throw new Error("Server PUT receipt differs");
        await verifyAcknowledgedR2Object(config, target, intent.receipt!, options);
        intent.state = "verified"; save();
      }
      if (intent.state === "verified") {
        const remote = (await client.detail(id))!.assets.find((asset) => asset.upload_id === intent.upload_id);
        if (remote?.upload_state === "put_acknowledged") await change("verify_upload", { upload_id: intent.upload_id });
        else if (!remote || !["verified", "attached"].includes(remote.upload_state) || remote.put_etag !== intent.receipt!.etag || remote.object_version !== intent.receipt!.version) {
          throw new Error("Server verification checkpoint differs");
        }
      }
    }
    await sources.assertCurrent();
    return { operationId: id, assets: record.intents.map(({ source_path, state, receipt, ...intent }) => ({ source_path,
      upload: sqliteVerifiedUploadSchema.parse({ ...intent, ...receipt, verified: true }) })) };
  });
}

export async function attachSqliteUpload(root: string, config: SqliteServiceConfig, id: string, client: SqliteOperationClient) {
  const storage = createLocalJournalStorage(root, "sqlite-uploads", config.service_id, `${id}.json`);
  return storage.exclusively(async () => {
    let record = await readSqliteUploadRecord(root, config, id);
    if (record.pending) {
      const result = await client.observeRequest(root, record.pending);
      if (!result || result.request.outcome !== "applied") throw new Error("Attachment instruction remains unknown; preserve its request");
      record = { ...record, pending: undefined }; storage.replace(record);
    }
    for (const intent of record.intents) {
      const detail = await client.detail(id), remote = detail?.assets.find((asset) => asset.upload_id === intent.upload_id);
      if (!remote || remote.put_etag !== intent.receipt?.etag || remote.object_version !== intent.receipt?.version ||
        !["verified", "attached"].includes(remote.upload_state)) throw new Error("Upload is not verified for attachment");
      if (remote.upload_state === "verified") {
        const command = operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id, worker_version_id: detail!.worker_version_id,
          service_config_sha256: detail!.service_config_sha256, operation_id: id, request_id: crypto.randomUUID(),
          expected_version: detail!.operation.version, action: "attach_asset", upload_id: intent.upload_id });
        record = { ...record, pending: command }; storage.replace(record);
        await client.send(root, command);
        record = { ...record, pending: undefined };
      }
      intent.state = "attached";
      storage.replace(sqliteUploadRecordSchema.parse(record));
    }
  });
}
