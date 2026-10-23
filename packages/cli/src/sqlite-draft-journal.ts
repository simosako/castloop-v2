import { z } from "zod";
import { parseSqlitePublicationRequest, sqlitePublicationProtocol, sqlitePublicationRequestHash,
  sqlitePublicationRequestSchema, sqlitePublicationStatusSchema, sqliteServiceConfigHash, sqliteServiceConfigSchema,
  sqliteUploadKey, sqliteVerifiedUploadSchema } from "@castloop/shared";
import type { SqlitePublicationRequest, SqlitePublicationStatus, SqliteServiceConfig } from "@castloop/shared";
import { createLocalJournalStorage } from "./local-journal-storage";
import type { LocalJournalStorage } from "./local-journal-storage";
import { completedDomainConfiguration } from "./sqlite-domain-local";
import { ensureLocalJournalParents } from "./local-journal-path";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const fields = sqlitePublicationRequestSchema.shape;
export const sqliteDraftTargetSchema = z.object({ job_id: fields.job_id, kind: fields.kind, show_id: fields.show_id,
  episode_id: fields.episode_id, expected_show_state_version: fields.expected_show_state_version,
  base_revision_id: fields.base_revision_id, base_metadata_sha256: fields.service_config_sha256.optional(),
  expected_episode_lifecycle_version: fields.expected_episode_lifecycle_version,
}).strict().superRefine((value, context) => {
  if (value.kind === "show" ? value.episode_id !== undefined || value.base_revision_id !== undefined || value.base_metadata_sha256 !== undefined || value.expected_episode_lifecycle_version !== undefined :
    value.episode_id === undefined || (value.base_revision_id !== undefined) !== (value.base_metadata_sha256 !== undefined)) {
    context.addIssue({ code: "custom", message: "Draft target requires its exact Episode base and metadata identity" });
  }
});
export const sqliteDraftAssetSchema = z.object({ upload: sqliteVerifiedUploadSchema,
  source_path: z.string().min(1).max(2048) }).strict();
const publicationSchema = z.object({ request: sqlitePublicationRequestSchema, request_sha256: fields.service_config_sha256,
  status: sqlitePublicationStatusSchema.optional() }).strict();
const recordSchema = z.object({ schema_version: z.union([z.literal(1), z.literal(2)]), protocol: z.literal(sqlitePublicationProtocol),
  service_id: fields.service_id, service_config_sha256: fields.service_config_sha256, target: sqliteDraftTargetSchema,
  assets: z.array(sqliteDraftAssetSchema).max(2), publication: publicationSchema.optional(),
}).strict().superRefine((value, context) => {
  const assets = value.assets.map((entry) => entry.upload.asset);
  if (new Set(assets).size !== assets.length || assets.includes("cover_jpg") && assets.includes("cover_png") ||
    assets.some((asset) => value.target.kind === "show" ? !["show_metadata", "cover_jpg", "cover_png"].includes(asset) :
      !["episode_metadata", "audio"].includes(asset)) || value.assets.some(({ upload }) => upload.key !== sqliteUploadKey({
      show_id: value.target.show_id, draft_job_id: value.target.job_id, upload_id: upload.upload_id, asset: upload.asset }))) {
    context.addIssue({ code: "custom", message: "Draft assets differ from their frozen target" });
  }
});

export type SqliteDraftTarget = z.infer<typeof sqliteDraftTargetSchema>;
export type SqliteDraftAsset = z.infer<typeof sqliteDraftAssetSchema>;
export type SqliteDraftRecord = z.infer<typeof recordSchema>;
export type SqliteDraftJournal = { storage: LocalJournalStorage; load: () => Promise<SqliteDraftRecord>;
  replace: (record: SqliteDraftRecord) => void };

export function requireSqliteStatus(request: SqlitePublicationRequest, hash: string, status: SqlitePublicationStatus,
  previous?: SqlitePublicationStatus): void {
  if (status.service_id !== request.service_id || status.request_id !== request.request_id || status.job_id !== request.job_id ||
    status.request_sha256 !== hash || previous && (status.sequence !== previous.sequence ||
      ["succeeded", "failed", "blocked"].includes(previous.state) && JSON.stringify(previous) !== JSON.stringify(status) ||
      previous.state === "running" && status.state === "queued")) throw new Error("SQLite status differs from its frozen request or retained result");
}

function checkedRecord(input: unknown): SqliteDraftRecord {
  const record = recordSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(record)) > 16384) throw new Error("SQLite draft exceeds its local journal limit");
  if (record.publication) {
    const request = parseSqlitePublicationRequest(record.publication.request);
    const { base_metadata_sha256: _, ...target } = record.target;
    if (request.action !== "publish" || request.service_id !== record.service_id || request.service_config_sha256 !== record.service_config_sha256 ||
      Object.entries(target).some(([key, value]) => request[key as keyof SqlitePublicationRequest] !== value) ||
      JSON.stringify(request.payloads) !== JSON.stringify(record.assets.map((entry) => entry.upload))) {
      throw new Error("SQLite frozen publication differs from its draft");
    }
    if (record.publication.status) requireSqliteStatus(request, record.publication.request_sha256, record.publication.status);
  }
  return record;
}

export function sqliteDraftFileName(target: Pick<SqliteDraftTarget, "kind" | "show_id" | "episode_id">): string {
  return `${target.kind === "show" ? `show-${target.show_id}` : `episode-${target.show_id.length}-${target.show_id}-${target.episode_id}`}.json`;
}

export async function readSqliteDraftRecord(root: string, config: SqliteServiceConfig,
  target: Pick<SqliteDraftTarget, "kind" | "show_id" | "episode_id">, allowCompletedDomainChange = false): Promise<SqliteDraftRecord | null> {
  try {
    const record = checkedRecord(createLocalJournalStorage(root, "sqlite-drafts", config.service_id, sqliteDraftFileName(target)).read());
    const permitted = record.service_config_sha256 === await sqliteServiceConfigHash(config) || allowCompletedDomainChange &&
      ["succeeded", "failed"].includes(record.publication?.status?.state ?? "") && await completedDomainConfiguration(root, config, record.service_config_sha256);
    if (record.service_id !== config.service_id || !permitted ||
      record.target.kind !== target.kind || record.target.show_id !== target.show_id || record.target.episode_id !== target.episode_id) throw new Error("SQLite draft identity differs");
    if (record.publication && await sqlitePublicationRequestHash(record.publication.request) !== record.publication.request_sha256) throw new Error("SQLite draft publication hash differs");
    return record;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readSqliteArchivedDraft(root: string, config: SqliteServiceConfig, jobId: string): Promise<SqliteDraftRecord | null> {
  fields.job_id.parse(jobId);
  try {
    const record = checkedRecord(createLocalJournalStorage(root, "sqlite-publications", config.service_id, `${jobId}.json`).read());
    const permitted = record.service_config_sha256 === await sqliteServiceConfigHash(config) ||
      ["succeeded", "failed"].includes(record.publication?.status?.state ?? "") && await completedDomainConfiguration(root, config, record.service_config_sha256);
    if (record.target.job_id !== jobId || record.service_id !== config.service_id || !permitted ||
      !record.publication || await sqlitePublicationRequestHash(record.publication.request) !== record.publication.request_sha256) throw new Error("Archived SQLite publication differs");
    return record;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function openSqliteDraftJournal(root: string, input: SqliteServiceConfig,
  targetInput: SqliteDraftTarget): Promise<SqliteDraftJournal> {
  const config = sqliteServiceConfigSchema.parse(input), target = sqliteDraftTargetSchema.parse(targetInput);
  const hash = await sqliteServiceConfigHash(config);
  const storage = createLocalJournalStorage(root, "sqlite-drafts", config.service_id, sqliteDraftFileName(target));
  const initial = checkedRecord({ schema_version: 2, protocol: sqlitePublicationProtocol, service_id: config.service_id,
    service_config_sha256: hash, target, assets: [] });
  storage.initialize(initial);
  const loadAny = async () => {
    const record = checkedRecord(storage.read());
    const permitted = record.service_config_sha256 === hash || ["succeeded", "failed"].includes(record.publication?.status?.state ?? "") &&
      await completedDomainConfiguration(root, config, record.service_config_sha256);
    if (record.service_id !== config.service_id || !permitted || record.target.kind !== target.kind ||
      record.target.show_id !== target.show_id || record.target.episode_id !== target.episode_id) throw new Error("SQLite draft belongs to another service or target");
    if (record.publication && record.publication.request_sha256 !== await sqlitePublicationRequestHash(record.publication.request)) {
      throw new Error("SQLite draft has a different frozen publication hash");
    }
    return record;
  };
  await storage.exclusively(async () => {
    const existing = await loadAny();
    if (existing.target.job_id === target.job_id) {
      if (existing.service_config_sha256 !== hash) throw new Error("A completed old-configuration draft may only be archived, never reused");
      if (JSON.stringify(existing.target) !== JSON.stringify(target)) throw new Error("Keep the unpublished draft's original target and base");
      return;
    }
    if (!existing.publication?.status || !["succeeded", "failed"].includes(existing.publication.status.state)) {
      throw new Error("An unpublished or uncertain SQLite draft already exists for this target");
    }
    const archive = createLocalJournalStorage(root, "sqlite-publications", config.service_id, `${existing.target.job_id}.json`);
    archive.initialize(existing);
    if (JSON.stringify(checkedRecord(archive.read())) !== JSON.stringify(existing)) throw new Error("Preserve the different SQLite draft archive");
    storage.replace(initial);
  });
  return { storage, load: async () => {
    const record = await loadAny();
    if (JSON.stringify(record.target) !== JSON.stringify(target)) throw new Error("SQLite draft changed; preserve the newer draft");
    return record;
  }, replace: (record) => {
    const checked = checkedRecord(record);
    if (checked.service_id !== config.service_id || checked.service_config_sha256 !== hash ||
      JSON.stringify(checked.target) !== JSON.stringify(target)) throw new Error("SQLite draft identity cannot change");
    storage.replace(checked);
  } };
}

export function requireSettledSqliteDomainDrafts(root: string, config: SqliteServiceConfig): void {
  ensureLocalJournalParents(root, "sqlite-drafts", config.service_id);
  let names: string[];
  try { names = readdirSync(join(root, ".castloop", "sqlite-drafts", config.service_id)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (names.length > 10000) throw new Error("Draft inspection exceeds its local budget");
  for (const name of names) {
    const record = checkedRecord(createLocalJournalStorage(root, "sqlite-drafts", config.service_id, name).read());
    if (record.service_id !== config.service_id || !["succeeded", "failed"].includes(record.publication?.status?.state ?? "")) {
      throw new Error("Finish existing local drafts before changing the canonical origin; stale or uncertain inputs cannot be adopted");
    }
  }
}
