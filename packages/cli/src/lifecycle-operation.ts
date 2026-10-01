import { lifecycleAdminResponseSchema, serviceConfigSchema } from "@castloop/shared";
import type { LifecycleAdminResponse, ServiceConfig } from "@castloop/shared";
import { LifecycleAdminClient } from "./lifecycle-client";
import { expectedLifecycleOperation, validateLifecycleClientState } from "./lifecycle-journal";
import type { LifecycleClientState, LifecycleJournal } from "./lifecycle-journal";

type Receipt<Name extends LifecycleAdminResponse["result"]> = Extract<LifecycleAdminResponse, { result: Name }>;
export type LifecycleOperationEffects = { claim: LifecycleClientState["claim"];
  reserve: () => Promise<Receipt<"claimed">>; commit: () => Promise<Receipt<"committed">>;
  status: () => Promise<Receipt<"status">>; retry: () => Promise<Receipt<"requeued">> };

function load(journal: LifecycleJournal, effects: LifecycleOperationEffects): LifecycleClientState {
  const state = validateLifecycleClientState(journal.load());
  if (JSON.stringify(state.claim) !== JSON.stringify(effects.claim)) throw new Error("Lifecycle effects differ from the journal's frozen request");
  return state;
}

function receipt(state: LifecycleClientState, input: unknown, result: LifecycleAdminResponse["result"]): LifecycleAdminResponse {
  const value = lifecycleAdminResponseSchema.parse(input);
  if (value.result === "preview" || value.result !== result || value.service_id !== state.identity.service_id ||
    JSON.stringify(value.operation) !== JSON.stringify(expectedLifecycleOperation(state.claim))) throw new Error("Lifecycle receipt differs from the frozen request");
  return value;
}

async function requireIdleOwner(state: LifecycleClientState, effects: LifecycleOperationEffects, markerPresent: boolean): Promise<void> {
  const status = receipt(state, await effects.status(), "status");
  if (status.result !== "status" || status.ownership !== "held" || status.execution_active || status.marker_present !== markerPresent ||
    status.status?.state === "completed" || status.status?.state === "abandoned") {
    throw new Error("Lifecycle operation requires its unfinished owner without an active or unknown consumer");
  }
}

export async function runLifecycleClaim(journal: LifecycleJournal, effects: LifecycleOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "prepared") throw new Error("Lifecycle claim outcome is unknown or already consumed; never replay its POST");
    journal.save({ ...state, phase: "claim_requested" });
    const value = receipt(state, await effects.reserve(), "claimed");
    if (value.result !== "claimed") throw new Error("Invalid lifecycle claim receipt");
    journal.save({ ...state, phase: "claimed", claim_receipt: value.operation });
  });
}

export async function runLifecycleCommit(journal: LifecycleJournal, effects: LifecycleOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "claimed") throw new Error("Lifecycle commit outcome is unknown or already consumed; never replay its POST");
    await requireIdleOwner(state, effects, false);
    journal.save({ ...state, phase: "commit_requested" });
    const value = receipt(state, await effects.commit(), "committed");
    if (value.result !== "committed") throw new Error("Invalid lifecycle commit receipt");
    journal.save({ ...state, phase: "committed", commit_receipt: { key: value.key, created: value.created } });
  });
}

export async function runLifecycleRetry(journal: LifecycleJournal, effects: LifecycleOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "committed" || state.retry?.state === "requested") {
      throw new Error("Lifecycle retry outcome is unknown or its commit was not acknowledged; never replay its POST");
    }
    await requireIdleOwner(state, effects, true);
    const started = validateLifecycleClientState({ ...state, retry: { attempt: (state.retry?.attempt ?? 0) + 1, state: "requested" } });
    journal.save(started);
    const value = receipt(started, await effects.retry(), "requeued");
    if (value.result !== "requeued") throw new Error("Invalid lifecycle retry receipt");
    journal.save({ ...started, retry: { ...started.retry!, state: "requeued", key: value.key } });
  });
}

export async function inspectLifecycleOperation(journal: LifecycleJournal, effects: LifecycleOperationEffects):
  Promise<{ client_state: LifecycleClientState; server_status: Receipt<"status"> }> {
  const state = load(journal, effects);
  const status = receipt(state, await effects.status(), "status");
  if (status.result !== "status") throw new Error("Invalid lifecycle status receipt");
  return { client_state: state, server_status: status };
}

export function createLifecycleOperationEffects(configInput: ServiceConfig, input: LifecycleClientState,
  adminKey: string, client?: Pick<LifecycleAdminClient, "claim" | "commit" | "retry" | "status">): LifecycleOperationEffects {
  const config = serviceConfigSchema.parse(configInput);
  const state = validateLifecycleClientState(input);
  if (state.identity.service_id !== config.service_id || state.identity.account_id !== config.account_id ||
    state.identity.worker_name !== config.worker_name || state.identity.public_base_url !== config.public_base_url) {
    throw new Error("Lifecycle effects target another service/account/Worker/origin");
  }
  const api = client ?? new LifecycleAdminClient(config, adminKey);
  const claim = state.claim;
  return { claim, reserve: () => api.claim(claim), commit: () => api.commit({ ...claim, action: "commit" }),
    retry: () => api.retry({ ...claim, action: "retry" }),
    status: () => api.status({ schema_version: 1, service_id: claim.service_id, action: "status", request: claim.request }) };
}
