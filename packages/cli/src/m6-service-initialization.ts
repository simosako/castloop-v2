import { z } from "zod";
import { m6RuntimeReadinessSchema, m6RuntimeTargetSchema, m6ServiceConfigHash, serviceConfigSchema } from "@castloop/shared";
import type { M6RuntimeReadiness, M6RuntimeTarget, ServiceConfig } from "@castloop/shared";
import { createLocalJournalStorage } from "./local-journal-storage";
import { workerPayloadHash as digest } from "./worker-upload-hash";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({ config: serviceConfigSchema, operation_id: z.uuid(), service_config_sha256: checksum,
  worker_source_sha256: checksum, worker_metadata_sha256: checksum }).strict();
const stateSchema = z.object({ schema_version: z.literal(1), request: requestSchema,
  phase: z.enum(["prepared", "resources_requested", "resources_created", "deploy_requested", "deployed", "initialization_requested", "initialized"]),
  target: m6RuntimeTargetSchema.optional(), runtime_readiness: m6RuntimeReadinessSchema.optional() }).strict();
export type FreshM6InitializationState = z.infer<typeof stateSchema>;
export type FreshM6InitializationJournal = {
  load: () => FreshM6InitializationState;
  save: (state: FreshM6InitializationState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T>;
};
export type FreshM6InitializationEffects = {
  createResources: (config: ServiceConfig) => Promise<void>;
  deploy: (config: ServiceConfig, source: string, metadata: object) => Promise<{ deployment_id: string; worker_version_id: string }>;
  initialize: (config: ServiceConfig, target: M6RuntimeTarget) => Promise<M6RuntimeReadiness>;
};

function validateState(input: unknown): FreshM6InitializationState {
  const state = stateSchema.parse(input);
  const phase = stateSchema.shape.phase.options.indexOf(state.phase);
  if ((phase >= 4) !== (state.target !== undefined) || (phase === 6) !== (state.runtime_readiness !== undefined) || state.target &&
    (state.target.operation_id !== state.request.operation_id || state.target.service_config_sha256 !== state.request.service_config_sha256) ||
    state.runtime_readiness && (!state.target || state.runtime_readiness.operation_id !== state.target.operation_id ||
      state.runtime_readiness.service_config_sha256 !== state.target.service_config_sha256 || state.runtime_readiness.deployment_id !== state.target.deployment_id ||
      state.runtime_readiness.worker_version_id !== state.target.worker_version_id)) throw new Error("Fresh M6 journal has inconsistent frozen target or receipts");
  return state;
}

export async function createFreshM6InitializationJournal(root: string, input: ServiceConfig, operationId: string,
  source: string, metadata: object): Promise<FreshM6InitializationJournal> {
  const config = serviceConfigSchema.parse(input);
  const request = requestSchema.parse({ config, operation_id: operationId, service_config_sha256: await m6ServiceConfigHash(config),
    worker_source_sha256: digest(source), worker_metadata_sha256: digest(metadata) });
  const storage = createLocalJournalStorage(root, "service-initializations", undefined, `${config.service_id}.json`);
  const load = (): FreshM6InitializationState => {
    const state = validateState(storage.read());
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("This workspace already has a different frozen fresh M6 initialization");
    return state;
  };
  storage.initialize({ schema_version: 1, request, phase: "prepared" });
  load();
  return { load, exclusively: storage.exclusively, save: (input) => {
    storage.requireLock();
    const next = validateState(input);
    const previous = load();
    const phases = stateSchema.shape.phase.options;
    const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
    if (JSON.stringify(next.request) !== JSON.stringify(previous.request) || distance < 0 || distance > 1 ||
      distance === 0 && JSON.stringify(next) !== JSON.stringify(previous) || previous.target && JSON.stringify(next.target) !== JSON.stringify(previous.target)) {
      throw new Error("Frozen fresh M6 initialization cannot change or skip phases");
    }
    storage.replace(next);
  } };
}

async function initialize(journal: FreshM6InitializationJournal, effects: FreshM6InitializationEffects): Promise<void> {
  const state = journal.load();
  if (state.phase !== "deployed" || !state.target) throw new Error("Fresh initialization requires its acknowledged deploy; never infer or replay an unknown request");
  journal.save({ ...state, phase: "initialization_requested" });
  const readiness = await effects.initialize(state.request.config, state.target);
  journal.save({ ...state, phase: "initialized", runtime_readiness: readiness });
}

export async function runFreshM6Initialization(journal: FreshM6InitializationJournal, effects: FreshM6InitializationEffects,
  source: string, metadata: object): Promise<void> {
  const frozenMetadata: unknown = JSON.parse(JSON.stringify(metadata));
  if (!frozenMetadata || typeof frozenMetadata !== "object" || Array.isArray(frozenMetadata)) throw new Error("Invalid fresh Worker upload metadata");
  await journal.exclusively(async () => {
    let state = journal.load();
    if (state.phase !== "prepared") throw new Error("Fresh initialization may already have started; preserve unknown requests without replay");
    if (digest(source) !== state.request.worker_source_sha256 || digest(frozenMetadata) !== state.request.worker_metadata_sha256) {
      throw new Error("Fresh Worker source or metadata differs from its frozen journal");
    }
    journal.save({ ...state, phase: "resources_requested" });
    await effects.createResources(state.request.config);
    journal.save({ ...state, phase: "resources_created" });
    journal.save({ ...state, phase: "deploy_requested" });
    const deployment = await effects.deploy(state.request.config, source, frozenMetadata);
    state = { ...state, phase: "deployed", target: m6RuntimeTargetSchema.parse({ ...deployment,
      operation_id: state.request.operation_id, service_config_sha256: state.request.service_config_sha256 }) };
    journal.save(state);
    await initialize(journal, effects);
  });
}

export async function resumeFreshM6Initialization(journal: FreshM6InitializationJournal, effects: FreshM6InitializationEffects): Promise<void> {
  await journal.exclusively(async () => { await initialize(journal, effects); });
}
