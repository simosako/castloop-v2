import { z } from "zod";
import { publicationRequestSchema, serviceConfigSchema, stageUploadRequestSchema } from "@castloop/shared";
import type { PublicationRequest, ServiceConfig, StageUploadRequest } from "@castloop/shared";
import { createLocalDraftJournal, readLocalDraft } from "./local-draft-journal";
import type { LocalDraftJournal, LocalDraftState, LocalDraftTarget } from "./local-draft-journal";
import { prepareLocalPublication } from "./local-publication-preparation";
import type { LocalPublicationPreparation } from "./local-publication-preparation";
import { prepareLocalStagingUpload } from "./local-staging-preparation";
import type { LocalStagingSelection } from "./local-staging-preparation";
import type { PublicationAdminClient } from "./publication-client";
import type { PublicationClientState } from "./publication-journal";
import { runPublicationClaim, runPublicationCommit } from "./publication-operation";
import type { StagingAdminClient } from "./staging-client";
import { readLocalStagingOperation } from "./staging-journal";
import type { StagingClientState } from "./staging-journal";
import { createStagingOperationEffects, runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import { createStagingRestPut } from "./staging-rest";
import type { StagingRestOptions } from "./staging-rest";

type StagingHeader = Omit<StageUploadRequest, "payloads" | "draft_job_id" | "kind" | "show_id" | "episode_id">;
type PublicationHeader = Omit<PublicationRequest["request"], "job_id" | "kind" | "show_id" | "episode_id">;
const stagingHeaderSchema = z.object({ schema_version: stageUploadRequestSchema.shape.schema_version,
  operation_id: stageUploadRequestSchema.shape.operation_id, expected_show_generation: stageUploadRequestSchema.shape.expected_show_generation,
  expected_episode_generation: stageUploadRequestSchema.shape.expected_episode_generation, created_at: stageUploadRequestSchema.shape.created_at }).strict();
const publicationHeaderSchema = z.object({ schema_version: publicationRequestSchema.shape.request.shape.schema_version,
  action: z.literal("publish"), expected_show_generation: publicationRequestSchema.shape.request.shape.expected_show_generation,
  expected_episode_generation: publicationRequestSchema.shape.request.shape.expected_episode_generation,
  created_at: publicationRequestSchema.shape.request.shape.created_at }).strict();
export type LocalDraftStagingOptions = { rest: StagingRestOptions;
  client?: Pick<StagingAdminClient, "claim" | "begin" | "settle" | "finish" | "status"> };

function existingDraft(root: string, config: ServiceConfig, target: LocalDraftTarget): LocalDraftJournal {
  const snapshot = readLocalDraft(root, config, target);
  if (!snapshot.client_state || snapshot.lock_present) throw new Error("Draft operation requires an existing target journal without a retained lock");
  return createLocalDraftJournal(root, config, target, snapshot.client_state.draft_job_id, snapshot.client_state.base_revision_id);
}

function assertDraft(journal: LocalDraftJournal, state: LocalDraftState): void {
  if (JSON.stringify(journal.load()) !== JSON.stringify(state)) throw new Error("Target draft changed during its explicitly owned operation");
}

export async function runLocalDraftStaging(root: string, configInput: ServiceConfig, target: LocalDraftTarget,
  request: StagingHeader, selection: LocalStagingSelection, adminKey: string, options: LocalDraftStagingOptions): Promise<StagingClientState> {
  const config = serviceConfigSchema.parse(configInput);
  const header = stagingHeaderSchema.parse(request);
  const journal = existingDraft(root, config, target);
  return journal.exclusively(async (editor) => {
    const state = editor.load();
    if (state.phase !== "editable") throw new Error("A publication-prepared or frozen draft cannot receive uploads");
    for (const upload of state.uploads) {
      const snapshot = readLocalStagingOperation(root, config, upload.operation_id);
      if (snapshot.lock_present || !snapshot.client_state || snapshot.client_state.phase !== "finished" &&
        !(upload.operation_id === header.operation_id && snapshot.client_state.phase === "prepared")) {
        throw new Error("Preserve unresolved draft uploads; never automatically retry or replace them");
      }
    }
    const prepared = await prepareLocalStagingUpload(root, config,
      { ...header, ...state.target, draft_job_id: state.draft_job_id }, selection);
    try {
      const put = createStagingRestPut(config, prepared.sources, options.rest);
      const effects = createStagingOperationEffects(config, prepared.journal.load(), adminKey, put, options.client);
      editor.attachUpload(prepared.journal.load().upload.operation_id);
      const attached = editor.load();
      const checkLocalInputs = async () => {
        assertDraft(journal, attached);
        await prepared.sources.assertCurrent();
        assertDraft(journal, attached);
      };
      const guarded = { ...effects, checkLocalInputs };
      await runStagingClaim(prepared.journal, guarded);
      await runStagingBeginAndUpload(prepared.journal, guarded);
      await runStagingSettle(prepared.journal, guarded, { put_requests_settled: true, no_more_puts: true });
      await runStagingFinish(prepared.journal, guarded);
      assertDraft(journal, attached);
      return prepared.journal.load();
    } finally { await prepared.sources.dispose(); }
  });
}

export async function runLocalDraftPublication(root: string, configInput: ServiceConfig, target: LocalDraftTarget,
  request: PublicationHeader, options: Omit<LocalPublicationPreparation, "stagedOperationIds">, adminKey: string,
  client?: Pick<PublicationAdminClient, "claim" | "commit" | "retry" | "status">): Promise<PublicationClientState> {
  const config = serviceConfigSchema.parse(configInput);
  const header = publicationHeaderSchema.parse(request);
  const journal = existingDraft(root, config, target);
  return journal.exclusively(async (editor) => {
    const state = editor.load();
    if (state.phase === "frozen") throw new Error("A frozen draft cannot be published again");
    if (options.baseRevision?.revision_id !== state.base_revision_id) throw new Error("Publication base differs from the permanent draft base identity");
    const prepared = await prepareLocalPublication(root, config, { ...header, ...state.target, job_id: state.draft_job_id },
      { ...options, stagedOperationIds: state.uploads.map((upload) => upload.operation_id) }, adminKey, client);
    editor.preparePublication();
    const frozen = editor.load();
    const checkLocalInputs = async () => {
      assertDraft(journal, frozen);
      await prepared.effects.checkLocalInputs?.();
      assertDraft(journal, frozen);
    };
    const guarded = { ...prepared.effects, checkLocalInputs };
    await runPublicationClaim(prepared.journal, guarded);
    await runPublicationCommit(prepared.journal, guarded);
    assertDraft(journal, frozen);
    editor.acknowledgeCommit();
    return prepared.journal.load();
  });
}
