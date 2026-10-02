import { z } from "zod";
import { serviceConfigSchema, stageUploadRequestSchema, stagingOperationSchema } from "@castloop/shared";
import type { ServiceConfig, StageUploadRequest } from "@castloop/shared";
import { stagingClientOperation, stagingClientTargets } from "./staging-client";
import { readBoundedLocalJournal } from "./local-journal-read";
import { ensureLocalJournalParents, localJournalEntryExists as existsSync, releaseLocalJournalLock, syncLocalJournalDirectory } from "./local-journal-path";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const identitySchema = serviceConfigSchema.pick({ service_id: true, account_id: true, worker_name: true, public_base_url: true });
const stateSchema = z.object({ schema_version: z.literal(1), identity: identitySchema, upload: stageUploadRequestSchema,
  phase: z.enum(["prepared", "claim_requested", "claimed", "begin_requested", "begin_acknowledged", "puts_running", "puts_settled",
    "settlement_requested", "settled", "finish_requested", "finished"]),
  claim_receipt: stagingOperationSchema.optional(),
  begin_receipt: z.array(z.object({ key: z.string().min(1).max(256), length: z.number().int().positive().max(300000000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(2).optional(),
  put_outcome: z.enum(["staged", "aborted"]).optional(), acknowledged_puts: z.number().int().min(0).max(2).optional(),
  reason_code: z.literal("put_failed").optional(), finish_receipt: z.enum(["staged", "aborted"]).optional(),
}).strict();

export type StagingClientState = z.infer<typeof stateSchema>;
export type StagingJournal = { load: () => StagingClientState; save: (state: StagingClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };

export function validateStagingClientState(input: unknown): StagingClientState {
  const state = stateSchema.parse(input);
  const origin = new URL(state.identity.public_base_url);
  const phase = stateSchema.shape.phase.options.indexOf(state.phase);
  const operation = stagingClientOperation(state.upload);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    (phase >= 2) !== (state.claim_receipt !== undefined) || (phase >= 4) !== (state.begin_receipt !== undefined) ||
    (phase >= 6) !== (state.put_outcome !== undefined) || (phase >= 6) !== (state.acknowledged_puts !== undefined) ||
    (phase === 10) !== (state.finish_receipt !== undefined) || state.claim_receipt && JSON.stringify(state.claim_receipt) !== JSON.stringify(operation) ||
    state.begin_receipt && JSON.stringify(state.begin_receipt) !== JSON.stringify(stagingClientTargets(state.upload)) ||
    (state.put_outcome === "aborted") !== (state.reason_code !== undefined) || state.put_outcome === "staged" &&
      state.acknowledged_puts !== state.upload.payloads.length || state.put_outcome === "aborted" && state.acknowledged_puts! >= state.upload.payloads.length ||
    state.finish_receipt && state.finish_receipt !== state.put_outcome) {
    throw new Error("Staging journal has inconsistent frozen identity, phase or receipts");
  }
  return state;
}

function identityFromConfig(config: ServiceConfig): z.infer<typeof identitySchema> {
  return identitySchema.parse({ service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, public_base_url: config.public_base_url });
}

function readRecord(file: string): StagingClientState {
  return validateStagingClientState(readBoundedLocalJournal(file));
}

export function readLocalStagingOperation(root: string, input: ServiceConfig, operationId: string):
  { client_state: StagingClientState | null; lock_present: boolean; remote_state_checked: false } {
  const config = serviceConfigSchema.parse(input);
  const id = stageUploadRequestSchema.shape.operation_id.parse(operationId);
  ensureLocalJournalParents(root, "staging-uploads", config.service_id);
  const file = join(root, ".castloop", "staging-uploads", config.service_id, `${id}.json`);
  const state = existsSync(file) ? readRecord(file) : null;
  if (state && (JSON.stringify(state.identity) !== JSON.stringify(identityFromConfig(config)) || state.upload.operation_id !== id)) {
    throw new Error("Local staging journal belongs to another service/account/Worker/origin or operation");
  }
  return { client_state: state, lock_present: existsSync(`${file}.lock`), remote_state_checked: false };
}

export function createStagingJournal(root: string, configInput: ServiceConfig, input: StageUploadRequest): StagingJournal {
  const config = serviceConfigSchema.parse(configInput);
  const prepared = validateStagingClientState({ schema_version: 1, identity: identityFromConfig(config), upload: input, phase: "prepared" });
  const file = join(root, ".castloop", "staging-uploads", config.service_id, `${prepared.upload.operation_id}.json`);
  ensureLocalJournalParents(root, "staging-uploads", config.service_id, true);
  const syncDirectory = () => syncLocalJournalDirectory(dirname(file));
  const load = (): StagingClientState => {
    ensureLocalJournalParents(root, "staging-uploads", config.service_id);
    const state = readRecord(file);
    if (JSON.stringify(state.identity) !== JSON.stringify(prepared.identity) || JSON.stringify(state.upload) !== JSON.stringify(prepared.upload)) {
      throw new Error("This operation already has a different frozen staging request");
    }
    return state;
  };
  if (!existsSync(file)) {
    if (existsSync(`${file}.lock`)) throw new Error("Preserve the retained staging lock without recreating its missing journal");
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(prepared)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory();
  }
  load();
  let locked = false;
  return {
    load,
    save: (input) => {
      if (!locked) throw new Error("Staging journal writes require its exclusive client lock");
      const next = validateStagingClientState(input);
      const previous = load();
      const phases = stateSchema.shape.phase.options;
      const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
      if (JSON.stringify(next.identity) !== JSON.stringify(previous.identity) || JSON.stringify(next.upload) !== JSON.stringify(previous.upload) ||
        distance < 0 || distance > 1 || distance === 0 && JSON.stringify(next) !== JSON.stringify(previous) ||
        previous.claim_receipt && JSON.stringify(next.claim_receipt) !== JSON.stringify(previous.claim_receipt) ||
        previous.begin_receipt && JSON.stringify(next.begin_receipt) !== JSON.stringify(previous.begin_receipt) ||
        previous.put_outcome && (next.put_outcome !== previous.put_outcome || next.acknowledged_puts !== previous.acknowledged_puts ||
          next.reason_code !== previous.reason_code) || previous.finish_receipt && next.finish_receipt !== previous.finish_receipt) {
        throw new Error("Frozen staging journal cannot change, skip phases or reopen PUT permission");
      }
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      syncDirectory();
    },
    exclusively: async (callback) => {
      ensureLocalJournalParents(root, "staging-uploads", config.service_id);
      const lock = `${file}.lock`;
      const fd = openSync(lock, "wx", 0o600);
      locked = true;
      try { fsyncSync(fd); syncDirectory(); return await callback(); }
      finally { locked = false; releaseLocalJournalLock(root, "staging-uploads", config.service_id, lock, fd); }
    },
  };
}
