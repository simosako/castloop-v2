import { serviceConfigSchema, targetInspectionRequestSchema, targetInspectionResponseSchema } from "@castloop/shared";
import type { ServiceConfig, TargetInspectionResponse } from "@castloop/shared";
import { createLocalDraftJournal, readLocalDraft, rotateLocalDraft } from "./local-draft-journal";
import type { LocalDraftState, LocalDraftTarget } from "./local-draft-journal";
import { runLocalDraftPublication, runLocalDraftStaging } from "./local-draft-operation";
import type { LocalDraftStagingOptions } from "./local-draft-operation";
import type { LocalStagingSelection } from "./local-staging-preparation";
import type { PublicationAdminClient } from "./publication-client";
import { readLocalPublicationJob } from "./publication-journal";
import type { PublicationClientState } from "./publication-journal";
import { readLocalStagingOperation } from "./staging-journal";
import type { StagingClientState } from "./staging-journal";
import { TargetInspectionClient } from "./target-inspection-client";

type Inspection = Pick<TargetInspectionClient, "inspect">;
export type M6LocalUpdateOptions = LocalDraftStagingOptions & { inspector?: Inspection; now?: () => Date };
export type M6LocalPublishOptions = { audioPath?: string; inspector?: Inspection; now?: () => Date;
  client?: Pick<PublicationAdminClient, "claim" | "commit" | "retry" | "status"> };

function timestamp(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function requireSettledUploads(root: string, config: ServiceConfig, state: LocalDraftState): void {
  for (const upload of state.uploads) {
    const record = readLocalStagingOperation(root, config, upload.operation_id);
    if (!record.client_state || record.lock_present || record.client_state.phase !== "finished") {
      throw new Error("Preserve the unresolved upload identity; recovery is not authorized by a target snapshot");
    }
  }
}

async function inspect(root: string, config: ServiceConfig, target: LocalDraftTarget, adminKey: string, inspector?: Inspection):
  Promise<TargetInspectionResponse> {
  const request = targetInspectionRequestSchema.parse({ schema_version: 1, service_id: config.service_id, ...target });
  const before = readLocalDraft(root, config, target);
  if (before.lock_present) throw new Error("Preserve the retained local draft lock");
  const response = targetInspectionResponseSchema.parse(await (inspector ?? new TargetInspectionClient(config, adminKey)).inspect(request));
  if (JSON.stringify(response.request) !== JSON.stringify(request) ||
    JSON.stringify(readLocalDraft(root, config, target)) !== JSON.stringify(before)) throw new Error("Target or local draft changed during inspection");
  if (response.admission_state !== "open" || response.unfinished_show_operation || !response.show ||
    !(target.kind === "show" ? ["draft", "active"].includes(response.show.lifecycle) : response.show.lifecycle === "active") ||
    response.episode && !["draft", "active"].includes(response.episode.lifecycle)) {
    throw new Error("Target snapshot blocks this new operation; it does not authorize owner recovery");
  }
  return response;
}

function expected(snapshot: TargetInspectionResponse): { expected_show_generation: number; expected_episode_generation?: number } {
  return { expected_show_generation: snapshot.show!.generation,
    ...(snapshot.request.kind === "episode" ? { expected_episode_generation: snapshot.episode?.generation ?? 0 } : {}) };
}

export async function updateLocalM6Draft(root: string, configInput: ServiceConfig, target: LocalDraftTarget,
  selection: LocalStagingSelection, adminKey: string, options: M6LocalUpdateOptions): Promise<StagingClientState> {
  const config = serviceConfigSchema.parse(configInput);
  const before = readLocalDraft(root, config, target);
  if (before.lock_present || before.client_state?.phase === "publication_prepared") throw new Error("Preserve the frozen or locked publication draft");
  if (before.client_state) requireSettledUploads(root, config, before.client_state);
  const snapshot = await inspect(root, config, target, adminKey, options.inspector);
  const current = readLocalDraft(root, config, target).client_state;
  const baseId = snapshot.current_revision?.revision_id;
  const journal = !current ? createLocalDraftJournal(root, config, target, crypto.randomUUID(), baseId) : current.phase === "frozen" ?
    await rotateLocalDraft(root, config, target, crypto.randomUUID(), baseId) :
    createLocalDraftJournal(root, config, target, current.draft_job_id, baseId);
  const state = journal.load();
  return runLocalDraftStaging(root, config, target, { schema_version: 1, operation_id: crypto.randomUUID(),
    ...expected(snapshot), created_at: timestamp(options.now) }, selection, adminKey, { ...options, expectedDraftJobId: state.draft_job_id });
}

export async function publishLocalM6Draft(root: string, configInput: ServiceConfig, target: LocalDraftTarget,
  adminKey: string, options: M6LocalPublishOptions = {}): Promise<PublicationClientState> {
  const config = serviceConfigSchema.parse(configInput);
  const before = readLocalDraft(root, config, target);
  const state = before.client_state;
  if (!state || before.lock_present || state.phase === "frozen") throw new Error("Publication requires its unfinished local draft without a lock");
  requireSettledUploads(root, config, state);
  const previous = readLocalPublicationJob(root, config, state.draft_job_id);
  if (previous.lock_present || previous.client_state && previous.client_state.phase !== "prepared" ||
    state.phase === "publication_prepared" && !previous.client_state) throw new Error("Preserve the requested or missing publication journal without automatic replay");
  const snapshot = await inspect(root, config, target, adminKey, options.inspector);
  if (snapshot.current_revision?.revision_id !== state.base_revision_id) throw new Error("Current Episode base differs from the permanent draft identity");
  const generations = expected(snapshot);
  const retained = previous.client_state?.publication.request;
  if (retained && (retained.expected_show_generation !== generations.expected_show_generation ||
    retained.expected_episode_generation !== generations.expected_episode_generation)) throw new Error("Prepared publication generation changed; preserve its frozen request");
  return runLocalDraftPublication(root, config, target, { schema_version: 1, action: "publish", ...generations,
    created_at: retained?.created_at ?? timestamp(options.now) },
    { ...(snapshot.current_revision ? { baseRevision: snapshot.current_revision } : {}), ...(options.audioPath ? { audioPath: options.audioPath } : {}) },
    adminKey, options.client, state.draft_job_id);
}
