import { migrationBootstrapRequestSchema, migrationDeploymentClientStateSchema, m6WorkerDeploymentEvidenceSchema } from "@castloop/shared";
import type { M6WorkerDeploymentEvidence, MigrationBootstrapRequest, MigrationDeploymentClientState } from "@castloop/shared";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

export function migrationPayloadHash(input: string | object): string {
  return createHash("sha256").update(typeof input === "string" ? input : JSON.stringify(input)).digest("hex");
}

export function createMigrationDeploymentJournal(root: string, input: MigrationBootstrapRequest): MigrationDeploymentJournal {
  const request = migrationBootstrapRequestSchema.parse(input);
  const file = join(root, ".castloop", "migrations", `${request.bootstrap_id}.json`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const syncDirectory = () => {
    const fd = openSync(dirname(file), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const load = (): MigrationDeploymentClientState => {
    if (statSync(file).size > 16384) throw new Error("Local migration journal exceeds its record budget");
    const state = migrationDeploymentClientStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("Local bootstrap ID already has a different frozen request");
    return state;
  };
  if (!existsSync(file)) {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schema_version: 1, request, phase: "prepared" }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory();
  }
  load();
  let locked = false;
  return {
    load,
    save: (input) => {
      if (!locked) throw new Error("Local migration journal writes require its exclusive client lock");
      const state = migrationDeploymentClientStateSchema.parse(input);
      const previous = load();
      const phases = ["prepared", "start_requested", "uploading", "rest_settled", "settled"];
      if (JSON.stringify(state.request) !== JSON.stringify(request) || phases.indexOf(state.phase) < phases.indexOf(previous.phase) ||
        previous.worker_version_id && state.worker_version_id !== previous.worker_version_id ||
        previous.deployment && JSON.stringify(state.deployment) !== JSON.stringify(previous.deployment)) {
        throw new Error("Frozen local request/version or deployment progress cannot regress");
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
      try { return await callback(); }
      finally { locked = false; closeSync(fd); unlinkSync(lock); syncDirectory(); }
    },
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
