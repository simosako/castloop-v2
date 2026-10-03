import { migrationBootstrapRequestSchema, migrationDeploymentClientStateSchema, m6WorkerDeploymentEvidenceSchema } from "@castloop/shared";
import type { M6WorkerDeploymentEvidence, MigrationBootstrapRequest, MigrationDeploymentClientState } from "@castloop/shared";
import { createLocalJournalStorage } from "./local-journal-storage";
import { workerPayloadHash as migrationPayloadHash } from "./worker-upload-hash";
export { workerPayloadHash as migrationPayloadHash } from "./worker-upload-hash";

export type MigrationDeploymentJournal = {
  exclusively: <T>(callback: () => Promise<T>) => Promise<T>;
  load: () => MigrationDeploymentClientState;
  save: (value: MigrationDeploymentClientState) => void;
};
export type MigrationDeploymentEffects = {
  prepare: (request: MigrationBootstrapRequest) => Promise<void>;
  begin: (request: MigrationBootstrapRequest) => Promise<{ bootstrap_id: string; start_allowed: true }>;
  deploy: (source: string, metadata: object) => Promise<string>;
  inspect: (workerVersionId: string) => Promise<M6WorkerDeploymentEvidence>;
  settle: (request: MigrationBootstrapRequest, evidence: { bootstrap_id: string; rest_requests_settled: true; no_more_deploys: true;
    deployment: M6WorkerDeploymentEvidence }) => Promise<void>;
};

export function createMigrationDeploymentJournal(root: string, input: MigrationBootstrapRequest): MigrationDeploymentJournal {
  const request = migrationBootstrapRequestSchema.parse(input);
  const storage = createLocalJournalStorage(root, "migrations", undefined, `${request.bootstrap_id}.json`);
  const load = (): MigrationDeploymentClientState => {
    const state = migrationDeploymentClientStateSchema.parse(storage.read());
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("Local bootstrap ID already has a different frozen request");
    return state;
  };
  storage.initialize({ schema_version: 1, request, phase: "prepared" });
  load();
  return {
    load,
    save: (input) => {
      storage.requireLock("Local migration journal writes require its exclusive client lock");
      const state = migrationDeploymentClientStateSchema.parse(input);
      const previous = load();
      const phases = ["prepared", "start_requested", "uploading", "rest_settled", "settled"];
      if (JSON.stringify(state.request) !== JSON.stringify(request) || phases.indexOf(state.phase) < phases.indexOf(previous.phase) ||
        previous.worker_version_id && state.worker_version_id !== previous.worker_version_id ||
        previous.deployment && JSON.stringify(state.deployment) !== JSON.stringify(previous.deployment)) {
        throw new Error("Frozen local request/version or deployment progress cannot regress");
      }
      storage.replace(state);
    },
    exclusively: storage.exclusively,
  };
}

function verifyPayload(state: MigrationDeploymentClientState, source: string, metadata: object): void {
  if (migrationPayloadHash(source) !== state.request.worker_source_sha256 || migrationPayloadHash(metadata) !== state.request.worker_metadata_sha256) {
    throw new Error("Candidate Worker source or upload metadata differs from its frozen bootstrap request");
  }
}

async function finishSettlement(journal: MigrationDeploymentJournal, effects: MigrationDeploymentEffects): Promise<void> {
  let state = journal.load();
  if (state.phase === "settled") return;
  if (state.phase !== "rest_settled" || !state.worker_version_id) throw new Error("Deploy outcome is unknown; do not retry PUT or infer settlement from time/HEAD");
  if (!state.deployment) {
    const deployment = m6WorkerDeploymentEvidenceSchema.parse(await effects.inspect(state.worker_version_id));
    state = migrationDeploymentClientStateSchema.parse({ ...state, deployment });
    journal.save(state);
  }
  if (!state.deployment) throw new Error("Deployment inspection returned no durable evidence");
  await effects.settle(state.request, { bootstrap_id: state.request.bootstrap_id, rest_requests_settled: true,
    no_more_deploys: true, deployment: state.deployment });
  journal.save({ ...state, phase: "settled" });
}

export async function runMigrationCandidateDeployment(journal: MigrationDeploymentJournal, effects: MigrationDeploymentEffects,
  source: string, metadata: object): Promise<void> {
  const frozenMetadata: unknown = JSON.parse(JSON.stringify(metadata));
  if (!frozenMetadata || typeof frozenMetadata !== "object" || Array.isArray(frozenMetadata)) throw new Error("Invalid Worker upload metadata object");
  await journal.exclusively(async () => {
    const state = journal.load();
    verifyPayload(state, source, frozenMetadata);
    if (state.phase !== "prepared") throw new Error("Bootstrap deploy start may already have been used; inspect state and explicitly resume settlement, never automatically replay PUT");
    await effects.prepare(state.request);
    journal.save({ ...state, phase: "start_requested" });
    const authorization = await effects.begin(state.request);
    if (authorization.bootstrap_id !== state.request.bootstrap_id || authorization.start_allowed !== true) throw new Error("Unexpected bootstrap start authorization");
    journal.save({ ...state, phase: "uploading" });
    const workerVersionId = await effects.deploy(source, frozenMetadata);
    journal.save(migrationDeploymentClientStateSchema.parse({ ...state, phase: "rest_settled", worker_version_id: workerVersionId }));
    await finishSettlement(journal, effects);
  });
}

export async function resumeMigrationCandidateSettlement(journal: MigrationDeploymentJournal, effects: MigrationDeploymentEffects): Promise<void> {
  await journal.exclusively(async () => { await finishSettlement(journal, effects); });
}
