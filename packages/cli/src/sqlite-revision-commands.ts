import { z } from "zod";
import { sameEpisodeIdentity, stringifyToml } from "@castloop/shared";
import { diffEpisodeDraftFields, diffShowMetadataFields, sqliteRevisionPlanSchema } from "../../shared/src/sqlite-revisions";
import { parseSqlitePublicationRequest, sqlitePublicationRequestHash, sqlitePublicationStatusSchema } from "../../shared/src/sqlite-publication";
import type { SqlitePublicationStatus } from "../../shared/src/sqlite-publication";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { readSqliteDraftRecord, requireSqliteStatus } from "./sqlite-draft-journal";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { completedDomainConfiguration } from "./sqlite-domain-local";
import { readBoundedLocalJournal } from "./local-journal-read";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import { sqliteClientIdentity } from "./sqlite-operation-client";
import type { R2RestTransport } from "./verified-r2-put";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const journalSchema = sqliteRevisionPlanSchema.extend({ schema_version: z.literal(2),
  phase: z.enum(["prepared", "requested"]), status: sqlitePublicationStatusSchema.optional() }).strict();
const local = (root: string, config: SqliteServiceConfig, jobId: string) =>
  createLocalJournalStorage(root, "sqlite-revisions", config.service_id, `${z.uuid().parse(jobId)}.json`);

export function readRevisionPlanFile(file: string): unknown {
  try { return readBoundedLocalJournal(file, 8_388_608); }
  catch { throw new Error("Revision plan JSON is unreadable, invalid or exceeds its read budget"); }
}

export async function previewRevision(config: SqliteServiceConfig, key: string, showId: string, revisionId: string,
  episodeId?: string, transport?: R2RestTransport) {
  const detail = await new SqliteServiceClient(config, key, transport).revision(showId, revisionId, episodeId);
  const current = episodeId === undefined ? detail.current_show : detail.current_episode!;
  const target = episodeId === undefined ? detail.target_show_revision! : detail.target_episode_revision!;
  const identityPreserved = episodeId === undefined || sameEpisodeIdentity(detail.current_episode!.metadata, detail.target_episode_revision!.metadata);
  const allowed = detail.state === "open" && !!detail.admission_window_id && identityPreserved &&
    (episodeId === undefined ? detail.current_show.cover.extension === detail.target_show_revision!.cover.extension : detail.show_lifecycle === "published");
  const request = allowed ? parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", action: "restore_revision",
    kind: detail.kind, show_id: showId, service_id: config.service_id, request_id: crypto.randomUUID(), job_id: crypto.randomUUID(),
    worker_version_id: detail.worker_version_id, service_config_sha256: detail.service_config_sha256,
    admission_window_id: detail.admission_window_id, expected_show_state_version: detail.expected_show_state_version,
    ...(episodeId === undefined ? {} : { episode_id: episodeId, base_revision_id: detail.current_episode!.revision_id,
      expected_episode_lifecycle_version: detail.expected_episode_lifecycle_version }), target_revision_id: revisionId, payloads: [] }) : null;
  return { current, target_revision: target, show_lifecycle: detail.show_lifecycle, episode_lifecycle: detail.episode_lifecycle ?? null,
    resulting_lifecycle: "published", identity_preserved: identityPreserved, executable: allowed,
    changes: episodeId === undefined ? diffShowMetadataFields(detail.current_show.metadata, detail.target_show_revision!.metadata) :
      diffEpisodeDraftFields(detail.current_episode!.metadata, detail.target_episode_revision!.metadata),
    assets: episodeId === undefined ? { current: detail.current_show.cover, candidate: detail.target_show_revision!.cover, mode: "reuse_saved_cover" } :
      { current: detail.current_episode!.audio, candidate: detail.target_episode_revision!.audio, mode: "reuse_saved_audio" },
    plan: request ? { request, request_sha256: await sqlitePublicationRequestHash(request) } : null };
}

async function checkedPlan(config: SqliteServiceConfig, input: unknown) {
  const direct = sqliteRevisionPlanSchema.safeParse(input);
  const preview = z.object({ plan: sqliteRevisionPlanSchema }).safeParse(input);
  const plan = direct.success ? direct.data : preview.success ? preview.data.plan :
    z.object({ result: z.object({ plan: sqliteRevisionPlanSchema }) }).parse(input).result.plan;
  if (plan.request.service_id !== config.service_id || plan.request.service_config_sha256 !== await sqliteServiceConfigHash(config) ||
    plan.request_sha256 !== await sqlitePublicationRequestHash(plan.request)) throw new Error("Revision plan differs from its frozen identity");
  return plan;
}

export async function revisionProgress(root: string, config: SqliteServiceConfig, file: string) {
  const plan = await checkedPlan(config, readRevisionPlanFile(file));
  let record: z.infer<typeof journalSchema>;
  try { record = journalSchema.parse(local(root, config, plan.request.job_id).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (JSON.stringify(record.request) !== JSON.stringify(plan.request) || record.request_sha256 !== plan.request_sha256) throw new Error("Revision journal differs");
  return { job_id: plan.request.job_id, state: record.status?.state ?? (record.phase === "requested" ? "unknown" : "prepared"),
    publication_requested: record.phase === "requested", last_known_only: true };
}

async function requireNoDraft(root: string, config: SqliteServiceConfig, showId: string, episodeId?: string) {
  const draft = await readSqliteDraftRecord(root, config, { kind: episodeId === undefined ? "show" : "episode", show_id: showId, episode_id: episodeId });
  if (draft && !["succeeded", "failed"].includes(draft.publication?.status?.state ?? "")) {
    throw new Error("Preserve the unfinished local draft before adopting a revision or exporting metadata");
  }
}

export async function readRevisionJob(root: string, config: SqliteServiceConfig, jobId: string) {
  let record: z.infer<typeof journalSchema>;
  try { record = journalSchema.parse(local(root, config, jobId).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const historical = await completedDomainConfiguration(root, config, record.request.service_config_sha256);
  if (!historical) throw new Error("No exact completed domain transition permits this revision job lookup");
  await checkedPlan(historical, { request: record.request, request_sha256: record.request_sha256 });
  if (record.request.job_id !== jobId || record.phase === "prepared" && record.status) throw new Error("Revision journal evidence differs");
  if (record.status) requireSqliteStatus(record.request, record.request_sha256, record.status);
  return { record, observationConfig: historical };
}

export async function readRevisionStatus(root: string, config: SqliteServiceConfig, key: string, jobId: string, transport?: R2RestTransport) {
  const resolved = await readRevisionJob(root, config, jobId);
  if (!resolved) return undefined;
  const { record, observationConfig } = resolved;
  const status = await new SqlitePublicationClient(observationConfig, key, transport).observe(record.request);
  if (!status && record.status) throw new Error("Previously acknowledged revision job is missing");
  if (status) requireSqliteStatus(record.request, record.request_sha256, status, record.status);
  return status;
}

export async function executeRevision(root: string, config: SqliteServiceConfig, key: string, input: unknown,
  hash: string, confirmation: string, transport?: R2RestTransport) {
  const plan = await checkedPlan(config, input);
  if (confirmation !== "confirm" || hash !== plan.request_sha256) throw new Error("Revision execution requires the exact reviewed hash and confirm");
  const journal = local(root, config, plan.request.job_id), client = new SqlitePublicationClient(config, key, transport);
  let existing: unknown;
  try { existing = journal.read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!existing) await requireNoDraft(root, config, plan.request.show_id, plan.request.episode_id);
  journal.initialize({ schema_version: 2, ...plan, phase: "prepared" });
  return journal.exclusively(async () => {
    let record = journalSchema.parse(journal.read());
    if (record.request_sha256 !== hash || JSON.stringify(record.request) !== JSON.stringify(plan.request) || record.phase === "prepared" && record.status) {
      throw new Error("Preserve the different retained revision request");
    }
    let status: SqlitePublicationStatus | null;
    if (record.phase === "prepared") {
      await requireNoDraft(root, config, plan.request.show_id, plan.request.episode_id);
      const state = await new SqliteServiceClient(config, key, transport).inspect(plan.request.show_id, plan.request.episode_id);
      if (state.state !== "open" || state.worker_version_id !== plan.request.worker_version_id || state.admission_window_id !== plan.request.admission_window_id ||
        state.expected_show_state_version !== plan.request.expected_show_state_version || state.base_revision_id !== plan.request.base_revision_id ||
        state.expected_episode_lifecycle_version !== plan.request.expected_episode_lifecycle_version) throw new Error("Revision plan base changed; preview and obtain approval again");
      record = { ...record, phase: "requested" }; journal.replace(record);
      status = await client.submit(plan.request, sqliteClientIdentity(root, config, true)!);
    } else status = await client.observe(plan.request);
    const deadline = performance.now() + 300000;
    let reads = 0;
    const budget = { beforeAttempt: () => reads < 300 && performance.now() < deadline && ++reads > 0 };
    for (;;) {
      if (!status && record.status) throw new Error("Previously acknowledged revision job is missing");
      if (status) {
        requireSqliteStatus(plan.request, hash, status, record.status);
        record = { ...record, status }; journal.replace(record);
      }
      if (!status || ["succeeded", "failed", "blocked"].includes(status.state)) return status;
      if (reads >= 300 || performance.now() >= deadline) throw new Error("Revision waiting stopped; inspect the same job without resubmission");
      await Bun.sleep(1000);
      status = await client.observe(plan.request, budget);
    }
  });
}

export async function syncLocalMetadata(root: string, config: SqliteServiceConfig, key: string, showId: string,
  expectedRevision: string, episodeId?: string, output?: string, transport?: R2RestTransport) {
  z.uuid().parse(expectedRevision);
  await requireNoDraft(root, config, showId, episodeId);
  const snapshot = await new SqliteServiceClient(config, key, transport).content(showId, episodeId);
  const content = episodeId === undefined ? snapshot.show_content : snapshot.episode_content;
  if (!content || content.revision_id !== expectedRevision) throw new Error("Current revision differs from the reviewed revision");
  const file = output ? resolve(output) : join(root, showId, episodeId === undefined ? "show.toml" : `episode-${episodeId}.toml`);
  for (let parent = dirname(file);; parent = dirname(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error("Metadata output parents must be real directories");
    if (dirname(parent) === parent) break;
  }
  const source = stringifyToml(content.metadata);
  writeSyncedLocalFile(file, () => source);
  syncLocalJournalDirectory(dirname(file));
  return { path: file, revision_id: content.revision_id, result: "metadata_exported", assets_downloaded: false, existing_files_overwritten: false };
}
