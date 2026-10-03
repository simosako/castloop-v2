import { z } from "zod";
import { m6RuntimeReadinessSchema, m6RuntimeTargetSchema, m6ServiceConfigHash, m6ServiceUpdateRequestSchema, serviceConfigSchema } from "@castloop/shared";
import type { M6RuntimeReadiness, M6RuntimeTarget, M6ServiceUpdateRequest, ServiceConfig } from "@castloop/shared";
import { createLocalJournalStorage } from "./local-journal-storage";
import { workerPayloadHash } from "./worker-upload-hash";

const stateSchema = z.object({ schema_version: z.literal(1), config: serviceConfigSchema, request: m6ServiceUpdateRequestSchema,
  phase: z.enum(["prepared", "begin_requested", "admitted", "deploy_requested", "deployed", "completion_requested", "completed"]),
  target: m6RuntimeTargetSchema.optional(), runtime_readiness: m6RuntimeReadinessSchema.optional() }).strict();
export type M6UpdateClientState = z.infer<typeof stateSchema>;
export type M6UpdateJournal = { load: () => M6UpdateClientState; save: (state: M6UpdateClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };
export type M6UpdateEffects = {
  begin: (request: M6ServiceUpdateRequest) => Promise<void>;
  deploy: (config: ServiceConfig, request: M6ServiceUpdateRequest, source: string, metadata: object) => Promise<{ deployment_id: string; worker_version_id: string }>;
  complete: (request: M6ServiceUpdateRequest, target: M6RuntimeTarget) => Promise<M6RuntimeReadiness>;
};

function validate(input: unknown): M6UpdateClientState {
  const state = stateSchema.parse(input);
  const phase = stateSchema.shape.phase.options.indexOf(state.phase);
  if (state.config.service_id !== state.request.service_id || (phase >= 4) !== (state.target !== undefined) ||
    (phase === 6) !== (state.runtime_readiness !== undefined) || state.target &&
    (state.target.operation_id !== state.request.operation_id || state.target.service_config_sha256 !== state.request.service_config_sha256 ||
      state.target.worker_version_id === state.request.previous_worker_version_id) || state.runtime_readiness &&
    (state.runtime_readiness.operation_id !== state.target?.operation_id || state.runtime_readiness.deployment_id !== state.target.deployment_id ||
      state.runtime_readiness.worker_version_id !== state.target.worker_version_id || state.runtime_readiness.service_config_sha256 !== state.target.service_config_sha256)) {
    throw new Error("Compatible update journal has inconsistent phase or runtime receipts");
  }
  return state;
}

export async function createM6UpdateJournal(root: string, configInput: ServiceConfig, requestInput: M6ServiceUpdateRequest): Promise<M6UpdateJournal> {
  const config = serviceConfigSchema.parse(configInput);
  const request = m6ServiceUpdateRequestSchema.parse(requestInput);
  if (request.service_id !== config.service_id || request.service_config_sha256 !== await m6ServiceConfigHash(config)) {
    throw new Error("Compatible update configuration differs from its frozen request");
  }
  const storage = createLocalJournalStorage(root, "service-updates", config.service_id, `${request.operation_id}.json`);
  const load = (): M6UpdateClientState => {
    const state = validate(storage.read());
    if (JSON.stringify(state.config) !== JSON.stringify(config) || JSON.stringify(state.request) !== JSON.stringify(request)) {
      throw new Error("Compatible update journal belongs to another frozen request");
    }
    return state;
  };
  storage.initialize({ schema_version: 1, config, request, phase: "prepared" });
  load();
  return { load, exclusively: storage.exclusively, save: (input) => {
    storage.requireLock();
    const next = validate(input);
    const previous = load();
    const phases = stateSchema.shape.phase.options;
    const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
    if (JSON.stringify(next.config) !== JSON.stringify(config) || JSON.stringify(next.request) !== JSON.stringify(request) ||
      distance < 0 || distance > 1 || distance === 0 && JSON.stringify(next) !== JSON.stringify(previous) ||
      previous.target && JSON.stringify(previous.target) !== JSON.stringify(next.target)) throw new Error("Compatible update cannot rewrite receipts or skip phases");
    storage.replace(next);
  } };
}

async function complete(journal: M6UpdateJournal, effects: M6UpdateEffects): Promise<void> {
  const state = journal.load();
  if (state.phase !== "deployed" || !state.target) throw new Error("Only an acknowledged compatible deployment can complete; preserve unknown requests without replay");
  journal.save({ ...state, phase: "completion_requested" });
  const readiness = await effects.complete(state.request, state.target);
  journal.save({ ...state, phase: "completed", runtime_readiness: readiness });
}

export async function runM6Update(journal: M6UpdateJournal, effects: M6UpdateEffects, source: string, metadata: object): Promise<void> {
  const frozenMetadata: unknown = JSON.parse(JSON.stringify(metadata));
  if (!frozenMetadata || typeof frozenMetadata !== "object" || Array.isArray(frozenMetadata)) throw new Error("Invalid compatible upload metadata");
  await journal.exclusively(async () => {
    let state = journal.load();
    if (state.phase !== "prepared") throw new Error("Compatible update may already have started; preserve unknown requests without replay");
    if (workerPayloadHash(source) !== state.request.worker_source_sha256 || workerPayloadHash(frozenMetadata) !== state.request.worker_metadata_sha256) {
      throw new Error("Compatible update source or metadata differs from its frozen request");
    }
    journal.save({ ...state, phase: "begin_requested" });
    await effects.begin(state.request);
    journal.save({ ...state, phase: "admitted" });
    journal.save({ ...state, phase: "deploy_requested" });
    const deployment = await effects.deploy(state.config, state.request, source, frozenMetadata);
    state = { ...state, phase: "deployed", target: m6RuntimeTargetSchema.parse({ ...deployment,
      operation_id: state.request.operation_id, service_config_sha256: state.request.service_config_sha256 }) };
    journal.save(state);
    await complete(journal, effects);
  });
}

export async function resumeM6UpdateCompletion(journal: M6UpdateJournal, effects: M6UpdateEffects): Promise<void> {
  await journal.exclusively(async () => { await complete(journal, effects); });
}
