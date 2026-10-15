import { sqliteServiceConfigHash, sqliteServiceConfigSchema, sqliteUploadKey, sqliteVerifiedUploadSchema } from "@castloop/shared";
import type { SqliteServiceConfig, StagePayload } from "@castloop/shared";
import type { SqliteDraftAsset, SqliteDraftTarget } from "./sqlite-draft-journal";
import { createLocalJournalStorage } from "./local-journal-storage";
import { freezePayloadSources } from "./staging-sources";
import { putVerifiedR2Object, requireR2RestOptions } from "./verified-r2-put";
import type { R2RestOptions } from "./verified-r2-put";
import { resolve } from "node:path";

const contentTypes = { show_metadata: "application/toml", episode_metadata: "application/toml",
  cover_jpg: "image/jpeg", cover_png: "image/png", audio: "audio/mpeg" };

export async function uploadSqliteDraftAssets(root: string, input: SqliteServiceConfig, target: SqliteDraftTarget,
  payloads: readonly StagePayload[], paths: readonly string[], duration: number | undefined,
  options: R2RestOptions): Promise<SqliteDraftAsset[]> {
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
    for (const { source_path: _, ...intent } of intents) {
      sqliteVerifiedUploadSchema.parse({ ...intent, verified: true, etag: "preflight", version: "preflight" });
    }
    const storage = createLocalJournalStorage(root, "sqlite-uploads", config.service_id, `${crypto.randomUUID()}.json`);
    const record = { schema_version: 1, protocol: "sqlite-sequential-v1", service_id: config.service_id,
      service_config_sha256: await sqliteServiceConfigHash(config), target, state: "put_requested", intents };
    if (Buffer.byteLength(JSON.stringify(record)) > 16384) throw new Error("SQLite upload journal exceeds its limit");
    storage.initialize(record);
    if (JSON.stringify(storage.read()) !== JSON.stringify(record)) throw new Error("Preserve the different SQLite upload attempt");
    return await storage.exclusively(async () => {
      const entries: SqliteDraftAsset[] = [];
      for (const [index, { source_path, ...intent }] of intents.entries()) {
        await sources.withPayload(index, async (body, requireConsumed) => {
          const receipt = await putVerifiedR2Object(config, { key: intent.key, length: intent.length_bytes,
            sha256: intent.sha256, contentType: contentTypes[intent.asset] }, body, requireConsumed, options);
          entries.push({ source_path, upload: sqliteVerifiedUploadSchema.parse({ ...intent, ...receipt, verified: true }) });
        });
      }
      await sources.assertCurrent();
      storage.replace({ ...record, state: "verified", receipts: entries.map((entry) => entry.upload) });
      return entries;
    });
  } finally { await sources.dispose(); }
}
