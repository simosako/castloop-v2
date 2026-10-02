import { migrationBridgeClientStateSchema, migrationBridgeDeploymentEvidenceSchema, migrationBridgeDeploymentRequestSchema,
  migrationBridgeUploadSchema } from "@castloop/shared";
import type { MigrationBridgeClientState, MigrationBridgeDeploymentEvidence, MigrationBridgeDeploymentRequest } from "@castloop/shared";
import { migrationPayloadHash } from "./migration-deployment";
import { readBoundedLocalJournal } from "./local-journal-read";
import { ensureLocalJournalParents, localJournalEntryExists as existsSync, releaseLocalJournalLock, syncLocalJournalDirectory } from "./local-journal-path";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MigrationBridgeJournal = {
  load: () => MigrationBridgeClientState;
  save: (state: MigrationBridgeClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T>;
};
export type MigrationBridgeEffects = {
  preflight: (source: string, metadata: object) => Promise<void>;
  deploy: (source: string, metadata: object) => Promise<string>;
  inspect: (versionId: string) => Promise<MigrationBridgeDeploymentEvidence>;
};

export function createMigrationBridgeJournal(root: string, input: MigrationBridgeDeploymentRequest): MigrationBridgeJournal {
  const request = migrationBridgeDeploymentRequestSchema.parse(input);
  const file = join(root, ".castloop", "bridge-deployments", `${request.preparation.service_id}.json`);
  ensureLocalJournalParents(root, "bridge-deployments", undefined, true);
  const syncDirectory = () => syncLocalJournalDirectory(dirname(file));
  const load = (): MigrationBridgeClientState => {
    ensureLocalJournalParents(root, "bridge-deployments", undefined);
    const state = migrationBridgeClientStateSchema.parse(readBoundedLocalJournal(file));
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("This service already has a different frozen initial bridge request");
    return state;
  };
  if (!existsSync(file)) {
    if (existsSync(`${file}.lock`)) throw new Error("Preserve the retained bridge lock without recreating its missing journal");
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ schema_version: 1, request, phase: "prepared" })); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory();
  }
  load();
  let locked = false;
  return { load, save: (input) => {
    if (!locked) throw new Error("Initial bridge journal writes require its exclusive client lock");
    const state = migrationBridgeClientStateSchema.parse(input);
    const previous = load();
    const phases = ["prepared", "uploading", "rest_settled", "verified"];
    const distance = phases.indexOf(state.phase) - phases.indexOf(previous.phase);
    if (JSON.stringify(state.request) !== JSON.stringify(request) || distance < 0 || distance > 1 ||
      previous.worker_version_id && state.worker_version_id !== previous.worker_version_id ||
      previous.deployment && JSON.stringify(state.deployment) !== JSON.stringify(previous.deployment)) {
      throw new Error("Frozen initial bridge request/version/progress cannot change or skip phases");
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    syncDirectory();
  }, exclusively: async (callback) => {
    ensureLocalJournalParents(root, "bridge-deployments", undefined);
    const lock = `${file}.lock`;
    const fd = openSync(lock, "wx", 0o600);
    locked = true;
    try { fsyncSync(fd); syncDirectory(); return await callback(); }
    finally { locked = false; releaseLocalJournalLock(root, "bridge-deployments", undefined, lock, fd); }
  } };
}

async function verifyBridge(journal: MigrationBridgeJournal, effects: MigrationBridgeEffects): Promise<void> {
  const state = journal.load();
  if (state.phase === "verified") return;
  if (state.phase !== "rest_settled" || !state.worker_version_id) throw new Error("Initial bridge deploy outcome is unknown; never replay PUT or preview writes");
  const deployment = migrationBridgeDeploymentEvidenceSchema.parse(await effects.inspect(state.worker_version_id));
  journal.save(migrationBridgeClientStateSchema.parse({ ...state, phase: "verified", deployment }));
}

export async function runMigrationBridgeDeployment(journal: MigrationBridgeJournal, effects: MigrationBridgeEffects,
  source: string, metadataInput: object): Promise<void> {
  const metadata = migrationBridgeUploadSchema.parse(JSON.parse(JSON.stringify(metadataInput)));
  await journal.exclusively(async () => {
    const state = journal.load();
    if (state.phase !== "prepared") throw new Error("Initial bridge start may already have been used; never automatically replay PUT");
    if (metadata.annotations["workers/tag"] !== state.request.preparation.bridge_id ||
      migrationPayloadHash(source) !== state.request.preparation.worker_source_sha256 ||
      migrationPayloadHash(metadata) !== state.request.preparation.worker_metadata_sha256) throw new Error("Initial bridge source/metadata differs from its frozen preparation");
    await effects.preflight(source, metadata);
    journal.save({ ...state, phase: "uploading" });
    const versionId = await effects.deploy(source, metadata);
    journal.save(migrationBridgeClientStateSchema.parse({ ...state, phase: "rest_settled", worker_version_id: versionId }));
    await verifyBridge(journal, effects);
  });
}

export async function resumeMigrationBridgeInspection(journal: MigrationBridgeJournal, effects: MigrationBridgeEffects): Promise<void> {
  await journal.exclusively(async () => { await verifyBridge(journal, effects); });
}
