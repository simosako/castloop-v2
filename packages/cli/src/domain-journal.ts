import { z } from "zod";
import { domainConnectionReceiptSchema, domainOperationRequestSchema, parseServiceConfig, serviceConfigSchema,
  serviceOperationIdentity, serviceUrlChangeProgressSchema, stringifyToml } from "@castloop/shared";
import type { DomainOperationRequest, ServiceConfig } from "@castloop/shared";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { ensureLocalJournalParents, localJournalEntryExists, syncLocalJournalDirectory } from "./local-journal-path";
import { readLocalMetadata } from "./local-metadata-read";
import { workerPayloadHash } from "./worker-upload-hash";
import { lstatSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

const stateSchema = z.object({ schema_version: z.literal(1), config: serviceConfigSchema, request: domainOperationRequestSchema,
  progress: serviceUrlChangeProgressSchema.optional(), connection_receipt: domainConnectionReceiptSchema.optional(), completed: z.boolean(),
  pending: z.object({ action: z.enum(["begin", "step", "complete", "claim-connection", "connection", "return-connection"]),
    execution_id: z.uuid().optional() }).strict().optional() }).strict();
export type DomainClientState = z.infer<typeof stateSchema>;
export type DomainJournal = { load: () => DomainClientState; save: (state: DomainClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };

export function domainTargetConfig(state: Pick<DomainClientState, "config" | "request">): ServiceConfig {
  return serviceConfigSchema.parse({ ...state.config, public_base_url: state.request.public_base_url,
    workers_dev_base_url: state.request.workers_dev_base_url });
}

function validate(input: unknown): DomainClientState {
  const state = stateSchema.parse(input);
  if (workerPayloadHash(state.config) !== state.request.service_config_sha256 ||
    workerPayloadHash(domainTargetConfig(state)) !== state.request.target_service_config_sha256 ||
    state.config.service_id !== state.request.service_id || serviceOperationIdentity(state.config).public_base_url !== state.request.workers_dev_base_url ||
    state.progress && JSON.stringify(state.progress.request) !== JSON.stringify(state.request) ||
    state.connection_receipt && state.connection_receipt.action !== state.request.domain_change.action ||
    state.progress?.connection_receipt && state.connection_receipt &&
      JSON.stringify(state.progress.connection_receipt) !== JSON.stringify(state.connection_receipt) ||
    state.pending && state.pending.action.includes("connection") !== (state.pending.execution_id !== undefined) ||
    state.completed && (state.pending || state.progress?.phase !== "complete" || !state.connection_receipt)) {
    throw new Error("Domain journal has inconsistent frozen configuration, request, progress or receipts");
  }
  return state;
}

export function readLocalDomainChanges(root: string, config: ServiceConfig): Array<{ state: DomainClientState; lock_present: boolean }> {
  ensureLocalJournalParents(root, "domain-changes", config.service_id);
  const directory = join(root, ".castloop", "domain-changes", config.service_id);
  if (!localJournalEntryExists(directory)) return [];
  const files = readdirSync(directory).filter((name) => name.endsWith(".json") || name.endsWith(".json.lock"));
  if (files.length > 2000) throw new Error("Domain journal listing exceeds its bounded inventory");
  for (const lock of files.filter((name) => name.endsWith(".lock"))) {
    if (!files.includes(lock.slice(0, -5))) throw new Error("Preserve the unknown domain client lock without recreating its journal");
  }
  return files.filter((name) => name.endsWith(".json")).sort().map((name) => {
    const id = domainOperationRequestSchema.shape.operation_id.parse(name.slice(0, -5));
    const storage = createLocalJournalStorage(root, "domain-changes", config.service_id, name);
    const state = validate(storage.read());
    if (state.request.operation_id !== id || JSON.stringify(serviceOperationIdentity(state.config)) !== JSON.stringify(serviceOperationIdentity(config))) {
      throw new Error("Domain journal belongs to another permanent operation or service");
    }
    return { state, lock_present: localJournalEntryExists(`${storage.path}.lock`) };
  });
}

export function createDomainJournal(root: string, config: ServiceConfig, request: DomainOperationRequest): DomainJournal {
  const initial = validate({ schema_version: 1, config, request, completed: false });
  const storage = createLocalJournalStorage(root, "domain-changes", config.service_id, `${request.operation_id}.json`);
  const load = () => {
    const state = validate(storage.read());
    if (JSON.stringify(state.config) !== JSON.stringify(initial.config) || JSON.stringify(state.request) !== JSON.stringify(initial.request)) {
      throw new Error("Domain journal has another permanent frozen request");
    }
    return state;
  };
  storage.initialize(initial);
  load();
  return { load, exclusively: storage.exclusively, save: (input) => {
    storage.requireLock();
    const next = validate(input);
    const previous = load();
    const phases = ["feeds", "configured", "complete"];
    if (JSON.stringify(next.config) !== JSON.stringify(previous.config) || JSON.stringify(next.request) !== JSON.stringify(previous.request) ||
      previous.completed && JSON.stringify(next) !== JSON.stringify(previous) || previous.connection_receipt &&
      JSON.stringify(next.connection_receipt) !== JSON.stringify(previous.connection_receipt) || previous.progress &&
      (!next.progress || phases.indexOf(next.progress.phase) < phases.indexOf(previous.progress.phase) || previous.progress.after_show_id &&
        (!next.progress.after_show_id || next.progress.after_show_id < previous.progress.after_show_id))) {
      throw new Error("Domain journal cannot rewrite receipts, frozen inputs or completed progress");
    }
    storage.replace(next);
  } };
}

export async function synchronizeDomainConfig(root: string, state: DomainClientState): Promise<void> {
  const file = join(root, "castloop.toml");
  const source = await readLocalMetadata(file);
  const config = parseServiceConfig(source.toString("utf8"));
  const target = domainTargetConfig(state);
  if (![state.request.service_config_sha256, state.request.target_service_config_sha256].includes(workerPayloadHash(config))) {
    throw new Error("Local service configuration has unrelated edits; preserve it without overwriting");
  }
  if (workerPayloadHash(config) === state.request.target_service_config_sha256) return;
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile()) throw new Error("Local service configuration must be a regular file");
  const temp = `${file}.${state.request.operation_id}.${crypto.randomUUID()}.tmp`;
  writeSyncedLocalFile(temp, () => stringifyToml(target));
  const after = lstatSync(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
    !(await readLocalMetadata(file)).equals(source)) throw new Error("Local settings changed during synchronization; preserve both files");
  renameSync(temp, file);
  syncLocalJournalDirectory(dirname(file));
  if (workerPayloadHash(parseServiceConfig((await readLocalMetadata(file)).toString("utf8"))) !== state.request.target_service_config_sha256) {
    throw new Error("Local service settings did not retain the frozen target after synchronization");
  }
}
