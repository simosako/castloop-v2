import { z } from "zod";
import { m6RuntimeReadinessSchema, m6RuntimeTargetSchema, m6ServiceConfigHash, m6ServiceUpdateRequestSchema, serviceConfigSchema, workerVersionUploadReceiptSchema } from "@castloop/shared";
import type { M6RuntimeReadiness, M6RuntimeTarget, M6ServiceUpdateRequest, ServiceConfig, WorkerVersionUploadReceipt } from "@castloop/shared";
import { createLocalJournalStorage } from "./local-journal-storage";
import { ensureLocalJournalParents, localJournalEntryExists } from "./local-journal-path";
import { workerPayloadHash } from "./worker-upload-hash";
import { bindLocalJournal } from "./validated-local-journal";
import type { ValidatedLocalJournal } from "./validated-local-journal";

const stateSchema = z.object({ schema_version: z.union([z.literal(1), z.literal(2)]), config: serviceConfigSchema, request: m6ServiceUpdateRequestSchema,
  phase: z.enum(["prepared", "begin_requested", "admitted", "deploy_requested", "deployed", "completion_requested", "completed"]),
  upload_receipt: workerVersionUploadReceiptSchema.optional(), deployment_receipt: m6RuntimeTargetSchema.optional(),
  activation_checkpoint: z.object({ previous_deployment_id: m6RuntimeTargetSchema.shape.deployment_id,
    state: z.enum(["not_started", "requested"]) }).strict().optional(),
  target: m6RuntimeTargetSchema.optional(), runtime_readiness: m6RuntimeReadinessSchema.optional() }).strict();
export type M6UpdateClientState = z.infer<typeof stateSchema>;
export type M6UpdateJournal = ValidatedLocalJournal<M6UpdateClientState>;
export type M6UpdateDeployReceipts = { uploaded: (receipt: WorkerVersionUploadReceipt, previousDeploymentId: string) => void;
  activating: () => void;
  deployed: (receipt: { deployment_id: string; worker_version_id: string }) => void };
export type M6UpdateEffects = {
  begin: (request: M6ServiceUpdateRequest) => Promise<void>;
  deploy: (config: ServiceConfig, request: M6ServiceUpdateRequest, source: string, metadata: object,
    receipts?: M6UpdateDeployReceipts) => Promise<{ deployment_id: string; worker_version_id: string }>;
  verifyDeployment?: (config: ServiceConfig, request: M6ServiceUpdateRequest, upload: WorkerVersionUploadReceipt,
    deployment: M6RuntimeTarget) => Promise<{ deployment_id: string; worker_version_id: string }>;
  activate?: (config: ServiceConfig, request: M6ServiceUpdateRequest, upload: WorkerVersionUploadReceipt,
    previousDeploymentId: string, receipts: M6UpdateDeployReceipts) => Promise<{ deployment_id: string; worker_version_id: string }>;
  complete: (request: M6ServiceUpdateRequest, target: M6RuntimeTarget) => Promise<M6RuntimeReadiness>;
};

function validate(input: unknown): M6UpdateClientState {
  const state = stateSchema.parse(input);
  const phase = stateSchema.shape.phase.options.indexOf(state.phase);
  if (state.schema_version === 1 && state.activation_checkpoint ||
    state.schema_version === 2 && !!state.upload_receipt !== !!state.activation_checkpoint ||
    state.activation_checkpoint && (phase < 3 || !state.upload_receipt ||
      state.activation_checkpoint.state === "not_started" && (phase !== 3 || !!state.deployment_receipt))) {
    throw new Error("Compatible update journal has inconsistent activation checkpoint");
  }
  if (state.config.service_id !== state.request.service_id || (phase >= 4) !== (state.target !== undefined) ||
    (phase === 6) !== (state.runtime_readiness !== undefined) || state.target &&
    (state.target.operation_id !== state.request.operation_id || state.target.service_config_sha256 !== state.request.service_config_sha256 ||
    state.target.worker_version_id === state.request.previous_worker_version_id) ||
    state.upload_receipt && (phase < 3 || state.upload_receipt.id === state.request.previous_worker_version_id) ||
    state.deployment_receipt && (!state.upload_receipt || state.deployment_receipt.worker_version_id !== state.upload_receipt.id ||
      state.deployment_receipt.operation_id !== state.request.operation_id || state.deployment_receipt.service_config_sha256 !== state.request.service_config_sha256 ||
      state.target && JSON.stringify(state.target) !== JSON.stringify(state.deployment_receipt)) || state.runtime_readiness &&
    (state.runtime_readiness.operation_id !== state.target?.operation_id || state.runtime_readiness.deployment_id !== state.target.deployment_id ||
      state.runtime_readiness.worker_version_id !== state.target.worker_version_id || state.runtime_readiness.service_config_sha256 !== state.target.service_config_sha256)) {
    throw new Error("Compatible update journal has inconsistent phase or runtime receipts");
  }
  return state;
}

export function readLocalM6Update(root: string, input: ServiceConfig, operationId: string): { state: M6UpdateClientState | null; lockPresent: boolean } {
  const config = serviceConfigSchema.parse(input);
  const id = m6ServiceUpdateRequestSchema.shape.operation_id.parse(operationId);
  ensureLocalJournalParents(root, "service-updates", config.service_id);
  const storage = createLocalJournalStorage(root, "service-updates", config.service_id, `${id}.json`);
  const state = localJournalEntryExists(storage.path) ? validate(storage.read()) : null;
  if (state && (JSON.stringify(state.config) !== JSON.stringify(config) || state.request.operation_id !== id)) throw new Error("Local update has another frozen identity");
  return { state, lockPresent: localJournalEntryExists(`${storage.path}.lock`) };
}

export async function createM6UpdateJournal(root: string, configInput: ServiceConfig, requestInput: M6ServiceUpdateRequest): Promise<M6UpdateJournal> {
  const config = serviceConfigSchema.parse(configInput);
  const request = m6ServiceUpdateRequestSchema.parse(requestInput);
  if (request.service_id !== config.service_id || request.service_config_sha256 !== await m6ServiceConfigHash(config)) {
    throw new Error("Compatible update configuration differs from its frozen request");
  }
  const storage = createLocalJournalStorage(root, "service-updates", config.service_id, `${request.operation_id}.json`);
  storage.initialize({ schema_version: 2, config, request, phase: "prepared" });
  return bindLocalJournal(storage, {
    parse: validate,
    assertIdentity: (state) => {
      if (JSON.stringify(state.config) !== JSON.stringify(config) || JSON.stringify(state.request) !== JSON.stringify(request)) {
        throw new Error("Compatible update journal belongs to another frozen request");
      }
    },
    assertTransition: (previous, next) => {
      const phases = stateSchema.shape.phase.options;
      const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
      const { upload_receipt: _previousUpload, deployment_receipt: _previousDeployment, activation_checkpoint: previousCheckpoint, ...previousState } = previous;
      const { upload_receipt: _nextUpload, deployment_receipt: _nextDeployment, activation_checkpoint: nextCheckpoint, ...nextState } = next;
      const checkpointChanged = JSON.stringify(previousCheckpoint) !== JSON.stringify(nextCheckpoint);
      if (checkpointChanged && !(previous.schema_version === 2 && previous.phase === "deploy_requested" && next.phase === "deploy_requested" &&
        (!previousCheckpoint && !previous.upload_receipt && next.upload_receipt && nextCheckpoint?.state === "not_started" ||
          previousCheckpoint?.state === "not_started" && nextCheckpoint?.state === "requested" &&
          previousCheckpoint.previous_deployment_id === nextCheckpoint.previous_deployment_id))) {
        throw new Error("Compatible update cannot infer or rewrite its activation checkpoint");
      }
      if (next.schema_version !== previous.schema_version || JSON.stringify(next.config) !== JSON.stringify(config) || JSON.stringify(next.request) !== JSON.stringify(request) ||
        distance < 0 || distance > 1 || distance === 0 && JSON.stringify(nextState) !== JSON.stringify(previousState) ||
        previous.upload_receipt && JSON.stringify(previous.upload_receipt) !== JSON.stringify(next.upload_receipt) ||
        previous.deployment_receipt && JSON.stringify(previous.deployment_receipt) !== JSON.stringify(next.deployment_receipt) ||
        previous.phase !== "deploy_requested" && (JSON.stringify(previous.upload_receipt) !== JSON.stringify(next.upload_receipt) ||
          JSON.stringify(previous.deployment_receipt) !== JSON.stringify(next.deployment_receipt)) ||
        previous.target && JSON.stringify(previous.target) !== JSON.stringify(next.target)) throw new Error("Compatible update cannot rewrite receipts or skip phases");
    },
  });
}

function deployReceipts(journal: M6UpdateJournal): M6UpdateDeployReceipts {
  return {
    uploaded: (receipt, previousDeploymentId) => journal.save({ ...journal.load(), upload_receipt: receipt,
      activation_checkpoint: { previous_deployment_id: previousDeploymentId, state: "not_started" } }),
    activating: () => {
      const state = journal.load();
      if (state.phase !== "deploy_requested" || state.activation_checkpoint?.state !== "not_started") {
        throw new Error("Activation requires its durable not-started checkpoint; preserve unknown requests without replay");
      }
      journal.save({ ...state, activation_checkpoint: { ...state.activation_checkpoint, state: "requested" } });
    },
    deployed: (receipt) => {
      const state = journal.load();
      journal.save({ ...state, deployment_receipt: m6RuntimeTargetSchema.parse({ ...receipt,
        operation_id: state.request.operation_id, service_config_sha256: state.request.service_config_sha256 }) });
    },
  };
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
    if (state.schema_version !== 2) throw new Error("Legacy compatible update journals cannot start the activation-checkpoint protocol");
    if (workerPayloadHash(source) !== state.request.worker_source_sha256 || workerPayloadHash(frozenMetadata) !== state.request.worker_metadata_sha256) {
      throw new Error("Compatible update source or metadata differs from its frozen request");
    }
    journal.save({ ...state, phase: "begin_requested" });
    await effects.begin(state.request);
    journal.save({ ...state, phase: "admitted" });
    journal.save({ ...state, phase: "deploy_requested" });
    const deployment = await effects.deploy(state.config, state.request, source, frozenMetadata, deployReceipts(journal));
    state = { ...journal.load(), phase: "deployed", target: m6RuntimeTargetSchema.parse({ ...deployment,
      operation_id: state.request.operation_id, service_config_sha256: state.request.service_config_sha256 }) };
    journal.save(state);
    await complete(journal, effects);
  });
}

export async function resumeM6UpdateActivation(journal: M6UpdateJournal, effects: M6UpdateEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = journal.load();
    if (state.schema_version !== 2 || state.phase !== "deploy_requested" || !state.upload_receipt || state.deployment_receipt ||
      state.activation_checkpoint?.state !== "not_started" || !effects.activate) {
      throw new Error("Activation continuation requires a durable not-started checkpoint; legacy or unknown activation requests cannot be replayed");
    }
    const deployment = await effects.activate(state.config, state.request, state.upload_receipt,
      state.activation_checkpoint.previous_deployment_id, deployReceipts(journal));
    journal.save({ ...journal.load(), phase: "deployed", target: m6RuntimeTargetSchema.parse({ ...deployment,
      operation_id: state.request.operation_id, service_config_sha256: state.request.service_config_sha256 }) });
    await complete(journal, effects);
  });
}

export async function resumeM6UpdateCompletion(journal: M6UpdateJournal, effects: M6UpdateEffects): Promise<void> {
  await journal.exclusively(async () => { await complete(journal, effects); });
}

export async function reconcileM6UpdateCompletion(journal: M6UpdateJournal,
  observe: (request: M6ServiceUpdateRequest, target: M6RuntimeTarget) => Promise<M6RuntimeReadiness>): Promise<void> {
  await journal.exclusively(async () => {
    const state = journal.load();
    if (state.phase !== "completion_requested" || !state.target) throw new Error("Reconciliation requires its retained completion request and acknowledged target");
    const readiness = await observe(state.request, state.target);
    journal.save({ ...state, phase: "completed", runtime_readiness: readiness });
  });
}

export async function resumeM6UpdateDeploymentVerification(journal: M6UpdateJournal, effects: M6UpdateEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = journal.load();
    if (state.phase !== "deploy_requested" || !state.upload_receipt || !state.deployment_receipt || !effects.verifyDeployment) {
      throw new Error("Preserve unknown deployment requests; verification requires both durable upload and deployment receipts");
    }
    const deployment = await effects.verifyDeployment(state.config, state.request, state.upload_receipt, state.deployment_receipt);
    journal.save({ ...state, phase: "deployed", target: m6RuntimeTargetSchema.parse({ ...deployment,
      operation_id: state.request.operation_id, service_config_sha256: state.request.service_config_sha256 }) });
    await complete(journal, effects);
  });
}
