import { publicationAdminResponseSchema, publicationCommitKey, publicationRequestSchema, serviceConfigSchema } from "@castloop/shared";
import type { PublicationAdminResponse, PublicationRequest, ServiceConfig } from "@castloop/shared";
import { PublicationAdminClient, publicationClientOperation } from "./publication-client";
import { validatePublicationClientState } from "./publication-journal";
import type { PublicationClientState, PublicationJournal } from "./publication-journal";
import { createHash } from "node:crypto";

type Receipt<Result extends PublicationAdminResponse["result"]> = Extract<PublicationAdminResponse, { result: Result }>;
export type PublicationOperationEffects = { publication: PublicationRequest; claim: () => Promise<Receipt<"claimed">>;
  commit: () => Promise<Receipt<"committed">>; status: () => Promise<Receipt<"status">>; retry: () => Promise<Receipt<"requeued">> };

function load(journal: PublicationJournal, effects: PublicationOperationEffects): PublicationClientState {
  const state = validatePublicationClientState(journal.load());
  if (JSON.stringify(state.publication) !== JSON.stringify(publicationRequestSchema.parse(effects.publication))) {
    throw new Error("Publication effects differ from the journal's frozen manifest");
  }
  return state;
}

function receipt(state: PublicationClientState, input: unknown, expected: PublicationAdminResponse["result"]): PublicationAdminResponse {
  const value = publicationAdminResponseSchema.parse(input);
  if (value.service_id !== state.identity.service_id || value.result !== expected || value.manifest_sha256 !== state.manifest_sha256 ||
    JSON.stringify(value.operation) !== JSON.stringify(publicationClientOperation(state.publication)) ||
    (value.result === "committed" || value.result === "requeued") && value.key !== publicationCommitKey(state.publication.commit) || value.result === "status" &&
    (JSON.stringify(value.publication) !== JSON.stringify(state.publication) ||
      value.request_sha256 !== createHash("sha256").update(JSON.stringify(state.publication.request)).digest("hex"))) {
    throw new Error("Publication receipt differs from the journal's frozen manifest/request");
  }
  return value;
}

export async function runPublicationClaim(journal: PublicationJournal, effects: PublicationOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "prepared") throw new Error("Publication claim outcome is unknown or consumed; never replay its POST");
    journal.save({ ...state, phase: "claim_requested" });
    const value = receipt(state, await effects.claim(), "claimed");
    if (value.result !== "claimed") throw new Error("Invalid publication claim receipt");
    journal.save({ ...state, phase: "claimed", claim_receipt: value.operation });
  });
}

export async function runPublicationCommit(journal: PublicationJournal, effects: PublicationOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "claimed") throw new Error("Publication commit outcome is unknown or consumed; never replay its POST");
    const status = receipt(state, await effects.status(), "status");
    if (status.result !== "status" || status.ownership !== "held" || status.execution_active || status.marker_present ||
      status.status?.state === "published" || status.status?.state === "abandoned") {
      throw new Error("Publication commit requires its unstarted held owner without active or unknown execution");
    }
    journal.save({ ...state, phase: "commit_requested" });
    const value = receipt(state, await effects.commit(), "committed");
    if (value.result !== "committed") throw new Error("Invalid publication commit receipt");
    journal.save({ ...state, phase: "committed", commit_receipt: { key: value.key, created: value.created } });
  });
}

export async function inspectPublicationOperation(journal: PublicationJournal, effects: PublicationOperationEffects):
  Promise<{ client_state: PublicationClientState; server_status: Receipt<"status"> }> {
  const state = load(journal, effects);
  const status = receipt(state, await effects.status(), "status");
  if (status.result !== "status") throw new Error("Invalid publication inspection result");
  return { client_state: state, server_status: status };
}

export async function runPublicationRetry(journal: PublicationJournal, effects: PublicationOperationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = load(journal, effects);
    if (state.phase !== "committed" || state.retry?.state === "requested") throw new Error("Publication retry outcome is unknown or its commit was not acknowledged; never replay its POST");
    const status = receipt(state, await effects.status(), "status");
    if (status.result !== "status" || status.ownership !== "held" || status.execution_active || !status.marker_present ||
      status.status?.state === "published" || status.status?.state === "abandoned") {
      throw new Error("Publication retry requires its unfinished held owner without active or unknown execution");
    }
    const started = validatePublicationClientState({ ...state, retry: { attempt: (state.retry?.attempt ?? 0) + 1, state: "requested" } });
    journal.save(started);
    const value = receipt(started, await effects.retry(), "requeued");
    if (value.result !== "requeued") throw new Error("Invalid publication retry receipt");
    journal.save({ ...started, retry: { ...started.retry!, state: "requeued", key: value.key } });
  });
}

export function createPublicationOperationEffects(configInput: ServiceConfig, input: PublicationClientState, adminKey: string,
  client?: Pick<PublicationAdminClient, "claim" | "commit" | "retry" | "status">): PublicationOperationEffects {
  const config = serviceConfigSchema.parse(configInput);
  const state = validatePublicationClientState(input);
  if (state.identity.service_id !== config.service_id || state.identity.account_id !== config.account_id ||
    state.identity.worker_name !== config.worker_name || state.identity.public_base_url !== config.public_base_url) {
    throw new Error("Publication effects target another service/account/Worker/origin");
  }
  const api = client ?? new PublicationAdminClient(config, adminKey);
  const publication = state.publication;
  return { publication, claim: () => api.claim(publication), commit: () => api.commit(publication), retry: () => api.retry(publication), status: () => api.status(publication) };
}
