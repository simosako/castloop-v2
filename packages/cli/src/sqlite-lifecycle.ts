import { z } from "zod";
import { parseSqlitePublicationRequest, sqlitePublicationRequestHash, sqlitePublicationRequestSchema, sqlitePublicationStatusSchema } from "../../shared/src/sqlite-publication";
import type { SqlitePublicationStatus } from "../../shared/src/sqlite-publication";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { createLocalJournalStorage } from "./local-journal-storage";
import { requireSqliteStatus } from "./sqlite-draft-journal";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import type { R2RestTransport } from "./verified-r2-put";

const lifecycleRequest = sqlitePublicationRequestSchema.refine((value) => value.action === "restore" || value.action === "unpublish", "Lifecycle plans cannot publish revisions or uploads");
export const sqliteLifecyclePlanSchema = z.object({ request: lifecycleRequest,
  request_sha256: sqlitePublicationRequestSchema.shape.service_config_sha256 }).strict();
export type SqliteLifecyclePlan = z.infer<typeof sqliteLifecyclePlanSchema>;
const recordSchema = sqliteLifecyclePlanSchema.extend({ phase: z.enum(["prepared", "requested"]), status: sqlitePublicationStatusSchema.optional() }).strict();
const local = (root: string, config: SqliteServiceConfig, jobId: string) => {
  sqlitePublicationRequestSchema.shape.job_id.parse(jobId);
  return createLocalJournalStorage(root, "sqlite-lifecycle", config.service_id, `${jobId}.json`);
};

async function checkedPlan(config: SqliteServiceConfig, input: unknown): Promise<SqliteLifecyclePlan> {
  const plan = sqliteLifecyclePlanSchema.parse(input);
  if (plan.request.service_id !== config.service_id || plan.request.service_config_sha256 !== await sqliteServiceConfigHash(config) ||
    plan.request_sha256 !== await sqlitePublicationRequestHash(plan.request)) throw new Error("SQLite lifecycle plan differs from its frozen identity");
  return plan;
}

export async function previewSqliteLifecycle(config: SqliteServiceConfig, key: string, showId: string, action: string,
  episodeId?: string, transport?: R2RestTransport): Promise<SqliteLifecyclePlan> {
  if (action !== "unpublish" && action !== "restore") throw new Error("SQLite deletion is not implemented: unregistered upload settlement is unresolved");
  const target = await new SqliteServiceClient(config, key, transport).inspect(showId, episodeId);
  if (target.state !== "open" || !target.admission_window_id || target.expected_show_state_version === null ||
    episodeId === undefined && target.show_lifecycle !== (action === "restore" ? "unpublished" : "published") ||
    episodeId !== undefined && (target.episode_lifecycle !== (action === "restore" ? "unpublished" : "published") ||
      !["published", ...(action === "unpublish" ? ["unpublished"] : [])].includes(target.show_lifecycle) || !target.base_revision_id)) {
    throw new Error("SQLite lifecycle target is unavailable; inspect its current state");
  }
  const request = parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", action, kind: episodeId === undefined ? "show" : "episode",
    show_id: showId, service_id: config.service_id, request_id: crypto.randomUUID(), job_id: crypto.randomUUID(),
    worker_version_id: target.worker_version_id, service_config_sha256: target.service_config_sha256,
    admission_window_id: target.admission_window_id, expected_show_state_version: target.expected_show_state_version,
    ...(episodeId !== undefined ? { episode_id: episodeId, base_revision_id: target.base_revision_id,
      expected_episode_lifecycle_version: target.expected_episode_lifecycle_version } : {}), payloads: [] });
  return { request, request_sha256: await sqlitePublicationRequestHash(request) };
}

export async function readSqliteLifecycleStatus(root: string, config: SqliteServiceConfig, key: string, jobId: string,
  transport?: R2RestTransport): Promise<SqlitePublicationStatus | null | undefined> {
  let record: z.infer<typeof recordSchema>;
  try { record = recordSchema.parse(local(root, config, jobId).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  await checkedPlan(config, { request: record.request, request_sha256: record.request_sha256 });
  if (record.request.job_id !== jobId || record.phase === "prepared" && record.status) throw new Error("SQLite lifecycle journal evidence differs");
  const status = await new SqlitePublicationClient(config, key, transport).observe(record.request);
  if (!status && record.status) throw new Error("Previously acknowledged SQLite lifecycle job is missing");
  if (status) requireSqliteStatus(record.request, record.request_sha256, status, record.status);
  return status;
}

export async function executeSqliteLifecycle(root: string, config: SqliteServiceConfig, key: string, input: unknown,
  hash: string, confirmation: string, transport?: R2RestTransport): Promise<SqlitePublicationStatus | null> {
  const plan = await checkedPlan(config, input);
  if (hash !== plan.request_sha256 || confirmation !== "confirm") throw new Error("SQLite lifecycle execution requires the exact reviewed hash and confirm");
  const journal = local(root, config, plan.request.job_id), client = new SqlitePublicationClient(config, key, transport);
  journal.initialize({ ...plan, phase: "prepared" });
  return journal.exclusively(async () => {
    let record = recordSchema.parse(journal.read());
    if (JSON.stringify(record.request) !== JSON.stringify(plan.request) || record.request_sha256 !== plan.request_sha256 ||
      record.phase === "prepared" && record.status) throw new Error("Keep the different retained SQLite lifecycle request");
    let status: SqlitePublicationStatus | null;
    if (record.phase === "prepared") {
      record = { ...record, phase: "requested" }; journal.replace(record);
      status = await client.submit(plan.request);
    } else status = await client.observe(plan.request);
    if (!status && record.status) throw new Error("Previously acknowledged SQLite lifecycle job is missing");
    if (status) {
      requireSqliteStatus(plan.request, plan.request_sha256, status, record.status);
      journal.replace({ ...record, status });
    }
    return status;
  });
}
