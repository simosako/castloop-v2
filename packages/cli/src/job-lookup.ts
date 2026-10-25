import { z } from "zod";
import { sqlitePublicationRequestHash, sqlitePublicationRequestSchema, sqliteServiceConfigHash, validateId } from "@castloop/shared";
import type { SqlitePublicationRequest, SqlitePublicationStatus, SqliteServiceConfig } from "@castloop/shared";
import { createLocalJournalStorage } from "./local-journal-storage";
import { readSqliteArchivedDraft, readSqliteDraftRecord } from "./sqlite-draft-journal";
import type { SqliteDraftRecord } from "./sqlite-draft-journal";
import { completedDomainConfiguration } from "./sqlite-domain-local";
import { readRevisionJob } from "./sqlite-revision-commands";
import { ensureLocalJournalParents } from "./local-journal-path";
import { sqliteUploadRecordSchema } from "./sqlite-upload";
import type { SqliteUploadRecord } from "./sqlite-upload";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const lifecycleRecordSchema = z.object({ request: sqlitePublicationRequestSchema, request_sha256: z.string().regex(/^[a-f0-9]{64}$/) });

export type SqliteJobResolution =
  | { source: "revision"; jobId: string; showId: string; episodeId: string | undefined;
      request: SqlitePublicationRequest; requestSha256: string; observationConfig: SqliteServiceConfig; submitted: boolean; status: SqlitePublicationStatus | null }
  | { source: "lifecycle"; jobId: string; showId: string; episodeId: string | undefined;
      request: SqlitePublicationRequest; observationConfig: SqliteServiceConfig }
  | { source: "draft"; jobId: string; showId: string; episodeId: string | undefined; record: SqliteDraftRecord }
  | { source: "publication"; jobId: string; showId: string; episodeId: string | undefined; record: SqliteDraftRecord;
      request: SqlitePublicationRequest; observationConfig: SqliteServiceConfig };

export async function resolveSqliteJob(root: string, config: SqliteServiceConfig, jobId: string): Promise<SqliteJobResolution | null> {
  const id = z.uuid().parse(jobId);
  const revision = await readRevisionJob(root, config, id);
  if (revision) {
    const { record, observationConfig } = revision;
    return { source: "revision", jobId: id, showId: record.request.show_id, episodeId: record.request.episode_id,
      request: record.request, requestSha256: record.request_sha256, observationConfig, submitted: record.phase === "requested", status: record.status ?? null };
  }
  try {
    const record = lifecycleRecordSchema.parse(createLocalJournalStorage(root, "sqlite-lifecycle", config.service_id, `${id}.json`).read());
    if (record.request.job_id !== id || record.request.service_id !== config.service_id ||
      await sqlitePublicationRequestHash(record.request) !== record.request_sha256) throw new Error("SQLite lifecycle journal evidence differs");
    return { source: "lifecycle", jobId: id, showId: validateId(record.request.show_id, "show"),
      episodeId: record.request.episode_id === undefined ? undefined : validateId(record.request.episode_id, "episode"),
      request: record.request, observationConfig: config };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const archived = await readSqliteArchivedDraft(root, config, id);
  if (archived?.publication) return await publicationResolution(root, config, id, archived);
  ensureLocalJournalParents(root, "sqlite-drafts", config.service_id);
  let names: string[] = [];
  try {
    names = readdirSync(join(root, ".castloop", "sqlite-drafts", config.service_id)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (names.length > 10000) throw new Error("Local job lookup exceeds its record budget");
  for (const name of names) {
    const raw = z.object({ target: z.object({ job_id: z.uuid(), kind: z.enum(["show", "episode"]), show_id: z.string(), episode_id: z.string().optional() }) }).parse(
      createLocalJournalStorage(root, "sqlite-drafts", config.service_id, name).read());
    if (raw.target.job_id !== id) continue;
    const record = await readSqliteDraftRecord(root, config, raw.target, true);
    if (!record) throw new Error("Matching SQLite draft journal disappeared");
    if (!record.publication) {
      return { source: "draft", jobId: id, showId: record.target.show_id, episodeId: record.target.episode_id, record };
    }
    return await publicationResolution(root, config, id, record);
  }
  return null;
}

async function publicationResolution(root: string, config: SqliteServiceConfig, jobId: string,
  record: SqliteDraftRecord): Promise<Extract<SqliteJobResolution, { source: "publication" }>> {
  const observationConfig = record.service_config_sha256 === await sqliteServiceConfigHash(config) ? config :
    await completedDomainConfiguration(root, config, record.service_config_sha256);
  if (!observationConfig) throw new Error("No exact completed domain transition permits this historical job lookup");
  return { source: "publication", jobId, showId: record.target.show_id, episodeId: record.target.episode_id,
    record, request: record.publication!.request, observationConfig };
}

export async function findSqliteUploadRecord(root: string, config: SqliteServiceConfig, jobId: string): Promise<SqliteUploadRecord | null> {
  ensureLocalJournalParents(root, "sqlite-uploads", config.service_id);
  let names: string[] = [];
  try {
    names = readdirSync(join(root, ".castloop", "sqlite-uploads", config.service_id)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (names.length > 10000) throw new Error("Local upload lookup exceeds its record budget");
  for (const name of names) {
    const parsed = sqliteUploadRecordSchema.safeParse(createLocalJournalStorage(root, "sqlite-uploads", config.service_id, name).read());
    if (parsed.success && parsed.data.target.job_id === jobId) return parsed.data;
  }
  return null;
}
