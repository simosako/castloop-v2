import { showRegistrationResponseSchema } from "@castloop/shared";
import type { ServiceConfig, ShowRegistrationResponse } from "@castloop/shared";
import { ShowRegistrationClient } from "./show-registration-client";
import type { M6AdminTransport } from "./m6-admin-json";
import { showRegistrationIdentity, showRegistrationIdentitySchema, validateShowRegistrationState } from "./show-registration-journal";
import type { ShowRegistrationClientState, ShowRegistrationJournal } from "./show-registration-journal";

export type ShowRegistrationEffects = { identity: ShowRegistrationClientState["identity"];
  reserve: (request: ShowRegistrationClientState["reserve"]) => Promise<unknown>;
  status: (request: ShowRegistrationClientState["reserve"]) => Promise<unknown> };

function loadRegistration(journal: ShowRegistrationJournal, effects: ShowRegistrationEffects): ShowRegistrationClientState {
  const state = validateShowRegistrationState(journal.load());
  if (JSON.stringify(showRegistrationIdentitySchema.parse(effects.identity)) !== JSON.stringify(state.identity)) {
    throw new Error("Show registration effects belong to another service/account/Worker/origin");
  }
  return state;
}

function checkedResponse(state: ShowRegistrationClientState, input: unknown, result: ShowRegistrationResponse["result"]): ShowRegistrationResponse {
  const response = showRegistrationResponseSchema.parse(input);
  if (response.result !== result || response.service_id !== state.reserve.service_id || response.show_id !== state.reserve.show_id ||
    response.reservation_id !== state.reserve.reservation_id) throw new Error("Show registration receipt differs from its frozen request");
  return response;
}

export async function runShowRegistration(journal: ShowRegistrationJournal, effects: ShowRegistrationEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = loadRegistration(journal, effects);
    if (state.phase === "registered") return;
    if (state.phase !== "prepared") throw new Error("Show registration outcome is unknown; do not replay reserve from observations or time");
    journal.save({ ...state, phase: "reserve_requested" });
    const receipt = checkedResponse(state, await effects.reserve(state.reserve), "reserved");
    if (receipt.result !== "reserved") throw new Error("Expected a Show reserve receipt");
    journal.save({ ...state, phase: "registered", receipt });
  });
}

export async function inspectShowRegistrationOperation(journal: ShowRegistrationJournal, effects: ShowRegistrationEffects):
  Promise<Extract<ShowRegistrationResponse, { result: "status" }>> {
  const state = loadRegistration(journal, effects);
  const response = checkedResponse(state, await effects.status(state.reserve), "status");
  if (response.result !== "status") throw new Error("Expected Show registration status");
  if (JSON.stringify(loadRegistration(journal, effects)) !== JSON.stringify(state)) throw new Error("Local Show registration changed during inspection");
  return response;
}

export function createShowRegistrationEffects(config: ServiceConfig, adminKey: string, transport?: M6AdminTransport): ShowRegistrationEffects {
  const client = new ShowRegistrationClient(config, adminKey, transport);
  return { identity: showRegistrationIdentity(config), reserve: (request) => client.reserve(request),
    status: (request) => client.status({ ...request, action: "status" }) };
}
