import { migrationBridgeClientStateSchema, migrationBridgeDeploymentEvidenceSchema, migrationBridgeDeploymentRequestSchema,
  migrationBridgeUploadSchema } from "@castloop/shared";
import type { MigrationBridgeClientState, MigrationBridgeDeploymentEvidence, MigrationBridgeDeploymentRequest } from "@castloop/shared";
import { migrationPayloadHash } from "./migration-deployment";
import { createLocalJournalStorage } from "./local-journal-storage";

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
  const storage = createLocalJournalStorage(root, "bridge-deployments", undefined, `${request.preparation.service_id}.json`);
  const load = (): MigrationBridgeClientState => {
    const state = migrationBridgeClientStateSchema.parse(storage.read());
    if (JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("This service already has a different frozen initial bridge request");
    return state;
  };
  storage.initialize({ schema_version: 1, request, phase: "prepared" });
  load();
  return { load, save: (input) => {
    storage.requireLock("Initial bridge journal writes require its exclusive client lock");
    const state = migrationBridgeClientStateSchema.parse(input);
    const previous = load();
    const phases = ["prepared", "uploading", "rest_settled", "verified"];
    const distance = phases.indexOf(state.phase) - phases.indexOf(previous.phase);
    if (JSON.stringify(state.request) !== JSON.stringify(request) || distance < 0 || distance > 1 ||
      previous.worker_version_id && state.worker_version_id !== previous.worker_version_id ||
      previous.deployment && JSON.stringify(state.deployment) !== JSON.stringify(previous.deployment)) {
      throw new Error("Frozen initial bridge request/version/progress cannot change or skip phases");
    }
    storage.replace(state);
  }, exclusively: storage.exclusively };
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
