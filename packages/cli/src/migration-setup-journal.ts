import { migrationSetupClientStateSchema, migrationSetupRequestSchema, serviceConfigSchema } from "@castloop/shared";
import type { MigrationSetupClientState, MigrationSetupRequest, ServiceConfig } from "@castloop/shared";
import { migrationPayloadHash } from "./migration-deployment";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  if (statSync(file).size > 16384) throw new Error("Migration setup journal exceeds its record budget");
  return validateMigrationSetupState(JSON.parse(readFileSync(file, "utf8")));
}

export function readLocalMigrationSetup(root: string, input: ServiceConfig): MigrationSetupLocalInspection {
  const config = serviceConfigSchema.parse(input);
  const file = join(root, ".castloop", "migration-setups", `${config.service_id}.json`);
  const state = existsSync(file) ? readSetupRecord(file) : null;
  if (state && (state.request.bridge.service_id !== config.service_id || state.request.bridge.account_id !== config.account_id ||
    state.request.bridge.worker_name !== config.worker_name)) throw new Error("Local migration setup belongs to another service/account/Worker");
  return { client_state: state, lock_present: existsSync(`${file}.lock`), remote_state_checked: false };
}

export function createMigrationSetupJournal(root: string, input: MigrationSetupRequest): MigrationSetupJournal {
  const request = migrationSetupRequestSchema.parse(input);
  const file = join(root, ".castloop", "migration-setups", `${request.bridge.service_id}.json`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const syncDirectory = () => {
    const fd = openSync(dirname(file), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const load = (): MigrationSetupClientState => {
    const state = readSetupRecord(file);
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("This service already has a different frozen migration setup request");
    return state;
  };
  if (!existsSync(file)) {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ schema_version: 1, request, phase: "prepared" })); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory();
  }
  load();
  let locked = false;
  return {
    load,
    save: (input) => {
      if (!locked) throw new Error("Migration setup journal writes require its exclusive client lock");
      const state = validateMigrationSetupState(input);
      const previous = load();
      const phases = migrationSetupClientStateSchema.shape.phase.options;
      const distance = phases.indexOf(state.phase) - phases.indexOf(previous.phase);
      if (JSON.stringify(state.request) !== JSON.stringify(request) || distance < 0 || distance > 1 ||
        previous.claim && JSON.stringify(state.claim) !== JSON.stringify(previous.claim) ||
        previous.quiescence && JSON.stringify(state.quiescence) !== JSON.stringify(previous.quiescence)) {
        throw new Error("Frozen migration setup/claim/quiescence cannot change or skip phases");
      }
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      syncDirectory();
    },
    exclusively: async (callback) => {
      const lock = `${file}.lock`;
      const fd = openSync(lock, "wx", 0o600);
      locked = true;
      try { fsyncSync(fd); syncDirectory(); return await callback(); }
      finally { locked = false; closeSync(fd); unlinkSync(lock); syncDirectory(); }
    },
  };
}
