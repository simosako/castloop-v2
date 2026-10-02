import { serviceConfigSchema, stageControlRequest, stageUploadRequestSchema, stagingAdminRequestSchema, stagingAdminResponseSchema } from "@castloop/shared";
import type { ServiceConfig, StageUploadRequest, StagingAdminResponse } from "@castloop/shared";
import { StagingAdminClient, stagingClientOperation, stagingClientTargets } from "./staging-client";
import type { StagePutTarget } from "./staging-client";
import { validateStagingClientState } from "./staging-journal";
import type { StagingClientState, StagingJournal } from "./staging-journal";
import { createHash } from "node:crypto";

type Receipt<Result extends StagingAdminResponse["result"]> = Extract<StagingAdminResponse, { result: Result }>;
export type StagingOperationEffects = { upload: StageUploadRequest; claim: () => Promise<Receipt<"claimed">>;
  begin: () => Promise<Receipt<"started">>; put: (target: StagePutTarget, index: number) => Promise<void>;
  settle: (evidence: { put_requests_settled: true; no_more_puts: true }) => Promise<Receipt<"settled">>;
  finish: (outcome: "staged" | "aborted") => Promise<Receipt<"staged" | "aborted">>; status: () => Promise<Receipt<"status">> };

function load(journal: StagingJournal, effects: StagingOperationEffects): StagingClientState {
  const state = validateStagingClientState(journal.load());
  if (JSON.stringify(state.upload) !== JSON.stringify(stageUploadRequestSchema.parse(effects.upload))) {
    throw new Error("Staging effects differ from the journal's frozen manifest");
  }
  return state;
}

function receipt(state: StagingClientState, input: unknown, result: StagingAdminResponse["result"]): StagingAdminResponse {
  const value = stagingAdminResponseSchema.parse(input);
  if (value.result !== result || value.service_id !== state.identity.service_id ||
    JSON.stringify(value.operation) !== JSON.stringify(stagingClientOperation(state.upload)) ||
    value.result === "started" && JSON.stringify(value.payloads) !== JSON.stringify(stagingClientTargets(state.upload)) ||
    value.result === "status" && (JSON.stringify(value.upload) !== JSON.stringify(state.upload) ||
      value.manifest_sha256 !== createHash("sha256").update(JSON.stringify(state.upload)).digest("hex") ||
      value.request_sha256 !== createHash("sha256").update(JSON.stringify(stageControlRequest(state.upload))).digest("hex"))) {
    throw new Error("Staging receipt differs from its frozen manifest/operation");
  }
  return value;
}

async function requireOwner(state: StagingClientState, effects: StagingOperationEffects, phase: "ready" | "uploading" | "settled"): Promise<void> {
  const status = receipt(state, await effects.status(), "status");
  if (status.result !== "status" || status.ownership !== "held" || status.verification_active || status.draft_committed || status.progress?.phase !== phase ||
    status.progress.client_settled !== (phase === "settled") || status.status?.state === "completed") {
    throw new Error("Staging operation requires its current unfinished owner, phase and idle verification");
  }
}

export async function runStagingClaim(journal: StagingJournal, effects: StagingOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "prepared") throw new Error("Staging claim outcome is unknown or consumed; never replay its POST");
    journal.save({ ...state, phase: "claim_requested" });
    const value = receipt(state, await effects.claim(), "claimed");
    if (value.result !== "claimed") throw new Error("Invalid staging claim receipt");
    journal.save({ ...state, phase: "claimed", claim_receipt: value.operation });
  });
}

export async function runStagingBeginAndUpload(journal: StagingJournal, effects: StagingOperationEffects): Promise<"staged" | "aborted"> {
  return journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "claimed") throw new Error("Staging begin/PUT outcome is unknown or consumed; never reopen PUT permission");
    await requireOwner(state, effects, "ready");
    journal.save({ ...state, phase: "begin_requested" });
    const value = receipt(state, await effects.begin(), "started");
    if (value.result !== "started") throw new Error("Invalid staging begin receipt");
    const acknowledged = validateStagingClientState({ ...state, phase: "begin_acknowledged", begin_receipt: value.payloads });
    journal.save(acknowledged);
    journal.save({ ...acknowledged, phase: "puts_running" });
    let acknowledgedPuts = 0;
    let failed = false;
    try {
      for (const target of value.payloads) {
        await effects.put(target, acknowledgedPuts);
        acknowledgedPuts += 1;
      }
    } catch { failed = true; }
    const outcome = failed ? "aborted" : "staged";
    journal.save({ ...acknowledged, phase: "puts_settled", put_outcome: outcome, acknowledged_puts: acknowledgedPuts,
      ...(failed ? { reason_code: "put_failed" } : {}) });
    return outcome;
  });
}

export async function runStagingSettle(journal: StagingJournal, effects: StagingOperationEffects,
  evidence: { put_requests_settled: true; no_more_puts: true }): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "puts_settled") throw new Error("Staging settlement requires acknowledged local PUT termination; never replay an unknown POST");
    stagingAdminRequestSchema.parse({ schema_version: 1, service_id: state.identity.service_id, action: "settle",
      operation: stagingClientOperation(state.upload), ...evidence });
    await requireOwner(state, effects, "uploading");
    journal.save({ ...state, phase: "settlement_requested" });
    receipt(state, await effects.settle(evidence), "settled");
    journal.save({ ...state, phase: "settled" });
  });
}

export async function runStagingFinish(journal: StagingJournal, effects: StagingOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "settled" || !state.put_outcome) throw new Error("Staging finish outcome is unknown or local PUT termination is unconfirmed; never replay its POST");
    await requireOwner(state, effects, "settled");
    journal.save({ ...state, phase: "finish_requested" });
    receipt(state, await effects.finish(state.put_outcome), state.put_outcome);
    journal.save({ ...state, phase: "finished", finish_receipt: state.put_outcome });
  });
}

export async function inspectStagingOperation(journal: StagingJournal, effects: StagingOperationEffects):
  Promise<{ client_state: StagingClientState; server_status: Receipt<"status"> }> {
  const state = load(journal, effects);
  const status = receipt(state, await effects.status(), "status");
  if (status.result !== "status") throw new Error("Invalid staging inspection result");
  return { client_state: state, server_status: status };
}

export function createStagingOperationEffects(configInput: ServiceConfig, input: StagingClientState, adminKey: string,
  put: StagingOperationEffects["put"], client?: Pick<StagingAdminClient, "claim" | "begin" | "settle" | "finish" | "status">): StagingOperationEffects {
  const config = serviceConfigSchema.parse(configInput);
  const state = validateStagingClientState(input);
  if (state.identity.service_id !== config.service_id || state.identity.account_id !== config.account_id ||
    state.identity.worker_name !== config.worker_name || state.identity.public_base_url !== config.public_base_url) {
    throw new Error("Staging effects target another service/account/Worker/origin");
  }
  const api = client ?? new StagingAdminClient(config, adminKey);
  const upload = state.upload;
  return { upload, claim: () => api.claim(upload), begin: () => api.begin(upload), put,
    settle: (evidence) => api.settle(upload, evidence), finish: (outcome) => api.finish(upload, outcome), status: () => api.status(upload) };
}
