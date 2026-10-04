import { z } from "zod";
import { serviceConfigSchema, serviceIdentitySchema, showRegistrationRequestSchema, showRegistrationResponseSchema, validateId } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { readBoundedLocalJournal } from "./local-journal-read";
import { ensureLocalJournalParents, localJournalEntryExists as existsSync } from "./local-journal-path";
import { createLocalJournalStorage } from "./local-journal-storage";
import { join } from "node:path";

export const showRegistrationIdentitySchema = serviceIdentitySchema;
const reserveSchema = showRegistrationRequestSchema.extend({ action: z.literal("reserve") });
const receiptSchema = showRegistrationResponseSchema.transform((value, context) => {
  if (value.result !== "reserved") {
    context.addIssue({ code: "custom", message: "Show registration journal requires a reserve receipt" });
    return z.NEVER;
  }
  return value;
});
const stateSchema = z.object({ schema_version: z.literal(1), identity: showRegistrationIdentitySchema, reserve: reserveSchema,
  phase: z.enum(["prepared", "reserve_requested", "registered"]), receipt: receiptSchema.optional() }).strict();

export type ShowRegistrationClientState = z.infer<typeof stateSchema>;
export type ShowRegistrationJournal = { load: () => ShowRegistrationClientState; save: (state: ShowRegistrationClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };

export function showRegistrationIdentity(config: ServiceConfig): z.infer<typeof showRegistrationIdentitySchema> {
  return showRegistrationIdentitySchema.parse({ service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, public_base_url: config.public_base_url });
}

export function validateShowRegistrationState(input: unknown): ShowRegistrationClientState {
  const state = stateSchema.parse(input);
  const origin = new URL(state.identity.public_base_url);
  const receipt = state.receipt;
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    state.reserve.service_id !== state.identity.service_id || (state.phase === "registered") !== (receipt !== undefined) ||
    receipt && (receipt.service_id !== state.reserve.service_id || receipt.show_id !== state.reserve.show_id || receipt.reservation_id !== state.reserve.reservation_id)) {
    throw new Error("Show registration journal has inconsistent identity, phase or receipt");
  }
  return state;
}

export function readLocalShowRegistration(root: string, input: ServiceConfig, showId: string):
  { client_state: ShowRegistrationClientState | null; lock_present: boolean; remote_state_checked: false } {
  const config = serviceConfigSchema.parse(input);
  const id = validateId(showId, "show");
  ensureLocalJournalParents(root, "show-registrations", config.service_id);
  const file = join(root, ".castloop", "show-registrations", config.service_id, `${id}.json`);
  const state = existsSync(file) ? validateShowRegistrationState(readBoundedLocalJournal(file)) : null;
  if (state && (JSON.stringify(state.identity) !== JSON.stringify(showRegistrationIdentity(config)) || state.reserve.show_id !== id)) {
    throw new Error("Local Show registration belongs to another service/account/Worker/origin or Show");
  }
  return { client_state: state, lock_present: existsSync(`${file}.lock`), remote_state_checked: false };
}

export function createShowRegistrationJournal(root: string, configInput: ServiceConfig, input: ShowRegistrationClientState["reserve"]): ShowRegistrationJournal {
  const config = serviceConfigSchema.parse(configInput);
  const prepared = validateShowRegistrationState({ schema_version: 1, identity: showRegistrationIdentity(config), reserve: input, phase: "prepared" });
  const storage = createLocalJournalStorage(root, "show-registrations", config.service_id, `${prepared.reserve.show_id}.json`);
  const load = (): ShowRegistrationClientState => {
    const state = validateShowRegistrationState(storage.read());
    if (JSON.stringify(state.identity) !== JSON.stringify(prepared.identity) || JSON.stringify(state.reserve) !== JSON.stringify(prepared.reserve)) {
      throw new Error("This Show already has a different frozen registration request");
    }
    return state;
  };
  storage.initialize(prepared);
  load();
  return { load,
    save: (input) => {
      storage.requireLock("Show registration journal writes require its exclusive client lock");
      const next = validateShowRegistrationState(input);
      const previous = load();
      const phases = stateSchema.shape.phase.options;
      const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
      if (JSON.stringify(next.identity) !== JSON.stringify(previous.identity) || JSON.stringify(next.reserve) !== JSON.stringify(previous.reserve) ||
        distance < 0 || distance > 1 || distance === 0 && JSON.stringify(next) !== JSON.stringify(previous) ||
        previous.receipt && JSON.stringify(next.receipt) !== JSON.stringify(previous.receipt)) {
        throw new Error("Frozen Show registration cannot change, skip phases or replay an unknown request");
      }
      storage.replace(next);
    },
    exclusively: storage.exclusively,
  };
}
