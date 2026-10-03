import { migrationSetupClientStateSchema, migrationSetupRequestSchema, serviceConfigSchema } from "@castloop/shared";
import type { MigrationSetupClientState, MigrationSetupRequest, ServiceConfig } from "@castloop/shared";
import { migrationPayloadHash } from "./migration-deployment";
import { readBoundedLocalJournal } from "./local-journal-read";
import { ensureLocalJournalParents, localJournalEntryExists as existsSync } from "./local-journal-path";
import { createLocalJournalStorage } from "./local-journal-storage";
import { join } from "node:path";

export type MigrationSetupJournal = { load: () => MigrationSetupClientState; save: (state: MigrationSetupClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };
export type MigrationSetupLocalInspection = { client_state: MigrationSetupClientState | null; lock_present: boolean; remote_state_checked: false };

export function validateMigrationSetupState(input: unknown): MigrationSetupClientState {
  const state = migrationSetupClientStateSchema.parse(input);
  if (state.quiescence && (!state.claim || state.quiescence.request_sha256 !== migrationPayloadHash(state.claim))) {
    throw new Error("Frozen quiescence does not match the migration claim hash");
  }
  return state;
}

function readSetupRecord(file: string): MigrationSetupClientState {
  return validateMigrationSetupState(readBoundedLocalJournal(file));
}

export function readLocalMigrationSetup(root: string, input: ServiceConfig): MigrationSetupLocalInspection {
  const config = serviceConfigSchema.parse(input);
  ensureLocalJournalParents(root, "migration-setups", undefined);
  const file = join(root, ".castloop", "migration-setups", `${config.service_id}.json`);
  const state = existsSync(file) ? readSetupRecord(file) : null;
  if (state && (state.request.bridge.service_id !== config.service_id || state.request.bridge.account_id !== config.account_id ||
    state.request.bridge.worker_name !== config.worker_name)) throw new Error("Local migration setup belongs to another service/account/Worker");
  return { client_state: state, lock_present: existsSync(`${file}.lock`), remote_state_checked: false };
}

export function createMigrationSetupJournal(root: string, input: MigrationSetupRequest): MigrationSetupJournal {
  const request = migrationSetupRequestSchema.parse(input);
  const storage = createLocalJournalStorage(root, "migration-setups", undefined, `${request.bridge.service_id}.json`);
  const load = (): MigrationSetupClientState => {
    const state = validateMigrationSetupState(storage.read());
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("This service already has a different frozen migration setup request");
    return state;
  };
  storage.initialize({ schema_version: 1, request, phase: "prepared" });
  load();
  return {
    load,
    save: (input) => {
      storage.requireLock("Migration setup journal writes require its exclusive client lock");
      const state = validateMigrationSetupState(input);
      const previous = load();
      const phases = migrationSetupClientStateSchema.shape.phase.options;
      const distance = phases.indexOf(state.phase) - phases.indexOf(previous.phase);
      const continuing = previous.phase === "initialization_pending" && state.phase === "initialization_requested";
      const completed = previous.phase === "initialization_requested" && state.phase === "controls_initialized";
      if (JSON.stringify(state.request) !== JSON.stringify(request) || (!continuing && !completed && (distance < 0 || distance > 1)) ||
        previous.phase === "initialization_pending" && distance !== 0 && !continuing ||
        distance === 0 && JSON.stringify(state) !== JSON.stringify(previous) ||
        previous.claim && JSON.stringify(state.claim) !== JSON.stringify(previous.claim) ||
        previous.quiescence && JSON.stringify(state.quiescence) !== JSON.stringify(previous.quiescence)) {
        throw new Error("Frozen migration setup/claim/quiescence cannot change or skip phases");
      }
      if (state.initialization) {
        const before = previous.initialization;
        const after = state.initialization;
        if (!before && after.step !== 1 || continuing && (!before || after.step !== before.step + 1 ||
          JSON.stringify(after.before) !== JSON.stringify(before.after)) || before && !continuing &&
          (after.step !== before.step || after.maximum_targets !== before.maximum_targets || JSON.stringify(after.before) !== JSON.stringify(before.before))) {
          throw new Error("Migration initialization cannot change or skip its frozen step");
        }
      }
      storage.replace(state);
    },
    exclusively: storage.exclusively,
  };
}
