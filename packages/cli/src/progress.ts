import { z } from "zod";
import { sqlitePublicationStatusSchema } from "@castloop/shared";
import type { SqlitePublicationStatus, SqliteServiceConfig } from "@castloop/shared";
import { sqliteUploadRecordSchema } from "./sqlite-upload";
import type { SqliteUploadRecord } from "./sqlite-upload";
import { findSqliteUploadRecord, resolveSqliteJob } from "./job-lookup";
import { administratorKey } from "./administrator-key";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqliteOperationClient } from "./sqlite-operation-client";
import type { R2RestTransport } from "./verified-r2-put";

export const progressPhaseSchema = z.object({
  phase: z.string().regex(/^[a-z][a-z0-9_:-]*$/).max(48),
  state: z.enum(["done", "in_progress", "pending", "unknown", "not_applicable"]),
  evidence: z.enum(["local_journal", "local_records", "remote_status", "none"]),
  detail: z.string().min(1).max(300),
}).strict();
export const progressResultSchema = z.object({
  schema_version: z.literal(1),
  job: z.object({ job_id: z.uuid(), source: z.enum(["lifecycle", "publication", "draft"]),
    kind: z.enum(["show", "episode"]), show_id: z.string(), episode_id: z.string().optional() }).strict(),
  status: sqlitePublicationStatusSchema.nullable(),
  state: z.enum(["draft", "queued", "running", "succeeded", "failed", "blocked", "unknown"]),
  waiting_reason: z.object({ reason: z.enum(["admission_paused", "head_job_blocked", "waiting_for_active", "waiting_in_fifo", "observation_gap"]),
    detail: z.string().min(1).max(300) }).strict().nullable(),
  phases: z.array(progressPhaseSchema).max(12),
  observation: z.object({ observed: z.boolean(), stale: z.boolean(), observed_at: z.string().nullable(),
    health_state: z.enum(["open", "paused"]).nullable(), note: z.string().max(300) }).strict(),
  snapshot_only: z.literal(true),
  authorizes_recovery: z.literal(false),
}).strict();
export type ProgressPhase = z.infer<typeof progressPhaseSchema>;
export type ProgressResult = z.infer<typeof progressResultSchema>;

function uploadPhaseState(state: SqliteUploadRecord["intents"][number]["state"]): ProgressPhase["state"] {
  if (state === "attached" || state === "verified") return "done";
  if (state === "put_acknowledged") return "in_progress";
  if (state === "put_requested") return "unknown";
  return "pending";
}

export async function readSqliteJobProgress(root: string, config: SqliteServiceConfig, jobId: string,
  transport?: R2RestTransport): Promise<ProgressResult> {
  const resolution = await resolveSqliteJob(root, config, jobId);
  if (!resolution) throw new Error("No matching SQLite job journal");
  const key = administratorKey(root);
  const record = resolution.source === "lifecycle" ? null : resolution.record;
  let status: SqlitePublicationStatus | null = null;
  let observed = false;
  let stale = false;
  if (resolution.source !== "draft") {
    try {
      status = await new SqlitePublicationClient(resolution.observationConfig, key, transport).observe(resolution.request);
      if (status === null && resolution.source === "publication" && resolution.record.publication!.status) {
        throw new Error("Previously acknowledged SQLite job is missing remotely; preserve its result");
      }
      observed = status !== null;
    } catch (error) {
      if (resolution.source === "publication" && resolution.record.publication!.status) {
        status = resolution.record.publication!.status;
        stale = true;
      } else throw error;
    }
  }
  const state: ProgressResult["state"] = resolution.source === "draft" ? "draft" : status ? status.state : "unknown";

  let waiting: ProgressResult["waiting_reason"] = null;
  let healthState: "open" | "paused" | null = null;
  let note = "";
  if (state === "queued") {
    if (stale) {
      waiting = { reason: "observation_gap", detail: "Remote observation failed; the last retained local status is shown" };
    } else {
      try {
        const client = new SqliteServiceClient(config, key, transport);
        const health = await client.health(resolution.showId);
        healthState = health.state;
        if (health.state === "paused") {
          waiting = { reason: "admission_paused", detail: "Show admission is paused; queued jobs are not executed until resume" };
        } else if (health.active === "blocked") {
          waiting = { reason: "head_job_blocked", detail: `The active job is blocked; the Show FIFO is halted${await blockingJobDetail(root, config, key, transport, resolution.showId)}` };
        } else if (health.active === "running") {
          waiting = { reason: "waiting_for_active", detail: `Another job is currently running${await blockingJobDetail(root, config, key, transport, resolution.showId)}` };
        } else {
          waiting = { reason: "waiting_in_fifo", detail: `${health.queued} job(s) are queued; the FIFO position of this job is not exposed` };
        }
      } catch {
        note = "Show health was not observable while queued";
      }
    }
  }

  const phases: ProgressPhase[] = [];
  phases.push({ phase: "input_frozen", state: "done", evidence: "local_journal",
    detail: resolution.source === "lifecycle" ? "Lifecycle plan is retained and hash-verified" : "Draft target and inputs are frozen" });
  const uploadRecord = record ? await findSqliteUploadRecord(root, config, jobId) : null;
  if (record) {
    for (const asset of record.assets) {
      const intent = uploadRecord?.intents.find((entry) => entry.upload_id === asset.upload.upload_id);
      phases.push({ phase: `upload:${asset.upload.asset}`, state: "done", evidence: "local_journal",
        detail: intent?.receipt ? "attached after a verified full readback" : "attached (upload journal not retained)" });
    }
    if (uploadRecord) {
      for (const intent of uploadRecord.intents) {
        if (record.assets.some((asset) => asset.upload.upload_id === intent.upload_id)) continue;
        phases.push({ phase: `upload:${intent.asset}`, state: uploadPhaseState(intent.state), evidence: "local_records",
          detail: intent.state === "put_requested" ? "PUT outcome is unknown; the request is not replayed" : `upload state is ${intent.state}` });
      }
    }
  }
  phases.push(record?.publication
    ? { phase: "publication_submitted", state: "done", evidence: "local_journal",
      detail: observed ? "Publication request is frozen and acknowledged remotely" : "Publication request is frozen" }
    : { phase: "publication_submitted", state: resolution.source === "lifecycle" ? "not_applicable" : "pending", evidence: "local_journal",
      detail: resolution.source === "lifecycle" ? "Lifecycle requests are not drafts" : "No publication request has been frozen" });
  const terminal = state === "succeeded" || state === "failed" || state === "blocked";
  phases.push({ phase: "fifo_waiting", state: state === "queued" ? "in_progress" : terminal || state === "running" ? "done" : state === "draft" ? "pending" : "unknown",
    evidence: observed ? "remote_status" : "local_journal",
    detail: state === "queued" ? waiting?.detail ?? "waiting in the Show FIFO" : state === "draft" ? "not submitted yet" : terminal || state === "running" ? "left the FIFO" : "queue membership is unknown" });
  phases.push({ phase: "executing", state: state === "running" ? "in_progress" : terminal ? "done" : state === "draft" || state === "queued" ? "pending" : "unknown",
    evidence: observed ? "remote_status" : "local_journal",
    detail: state === "running" ? "the job is running; internal steps and CPU are not observable" : state === "draft" || state === "queued" ? "not started" : terminal ? "execution finished" : "execution state is unknown" });
  phases.push({ phase: "cache_purge", state: "unknown", evidence: "none",
    detail: "not separately observable; a succeeded job has passed the cache purge completion gate" });
  phases.push({ phase: "terminal", state: terminal ? "done" : state === "draft" || state === "queued" || state === "running" ? "pending" : "unknown",
    evidence: observed ? "remote_status" : "local_journal",
    detail: terminal ? `${state}${status?.reason_code ? ` (${status.reason_code})` : ""}` : state === "draft" ? "not submitted yet" : "not finished" });

  return progressResultSchema.parse({ schema_version: 1,
    job: { job_id: resolution.jobId, source: resolution.source, kind: record ? record.target.kind : resolution.episodeId === undefined ? "show" : "episode",
      show_id: resolution.showId, ...(resolution.episodeId !== undefined ? { episode_id: resolution.episodeId } : {}) },
    status, state, waiting_reason: waiting, phases,
    observation: { observed, stale, observed_at: observed ? new Date().toISOString() : null, health_state: healthState, note }, snapshot_only: true, authorizes_recovery: false });
}

async function blockingJobDetail(root: string, config: SqliteServiceConfig, key: string, transport: R2RestTransport | undefined,
  showId: string): Promise<string> {
  try {
    const operations = await new SqliteOperationClient(config, key, transport, showId).list({ incomplete: true });
    const active = operations.operations.find((operation) => operation.kind === "publication" && operation.state === "in_progress" && operation.job_id);
    return active?.job_id ? ` (job ${active.job_id})` : "";
  } catch {
    return "";
  }
}

export function formatProgress(result: ProgressResult): string {
  const target = result.job.episode_id === undefined ? result.job.show_id : `${result.job.show_id}/${result.job.episode_id}`;
  const lines = [`Job ${result.job.job_id} (${result.job.kind} ${target}, ${result.job.source}): ${result.state}${result.observation.stale ? " [stale: last known local status]" : ""}`];
  for (const phase of result.phases) lines.push(`${phase.phase.padEnd(22)} ${phase.state.padEnd(14)} ${phase.detail}`);
  if (result.waiting_reason) lines.push(`Waiting: ${result.waiting_reason.reason} — ${result.waiting_reason.detail}`);
  if (result.observation.note) lines.push(`Note: ${result.observation.note}`);
  return lines.join("\n");
}
