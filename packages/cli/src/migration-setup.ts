import { migrationAdminStatusSchema, migrationQuiescenceSchema, migrationSetupRequestSchema, serviceConfigSchema, serviceMigrationRequestSchema } from "@castloop/shared";
import type { MigrationAdminStatus, MigrationQuiescence, MigrationSetupClientState, MigrationSetupRequest, ServiceConfig, ServiceMigrationRequest } from "@castloop/shared";
import { MigrationAdminClient } from "./migration-client";
import { migrationPayloadHash } from "./migration-deployment";
import { validateMigrationSetupState } from "./migration-setup-journal";
import type { MigrationSetupJournal } from "./migration-setup-journal";

export type MigrationSetupEffects = { request: MigrationSetupRequest; status: () => Promise<MigrationAdminStatus>; initialize: () => Promise<void>; pause: () => Promise<void>;
  claim: (request: ServiceMigrationRequest) => Promise<void>; confirm: (input: MigrationQuiescence) => Promise<void> };

function loadSetup(journal: MigrationSetupJournal, effects: MigrationSetupEffects): MigrationSetupClientState {
  const state = validateMigrationSetupState(journal.load());
  if (JSON.stringify(migrationSetupRequestSchema.parse(effects.request)) !== JSON.stringify(state.request)) {
    throw new Error("Migration setup effects do not match this journal's frozen request");
  }
  return state;
}

function requireIdentity(state: MigrationSetupClientState, input: unknown): MigrationAdminStatus {
  const status = migrationAdminStatusSchema.parse(input);
  const bridge = state.request.bridge;
  if (status.service_id !== bridge.service_id || status.account_id !== bridge.account_id || status.worker_name !== bridge.worker_name) {
    throw new Error("Migration setup status belongs to another service/account/Worker");
  }
  return status;
}

function requireBridge(state: MigrationSetupClientState, input: unknown): MigrationAdminStatus {
  const status = requireIdentity(state, input);
  const bridge = state.request.bridge;
  if (status.worker_protocol !== "legacy_fenced" || status.worker_version_id !== bridge.worker_version_id ||
    status.worker_bridge_id !== bridge.bridge_id || status.admission && status.admission.mode !== "legacy" || status.admission?.migration?.execution_id) {
    throw new Error("Migration setup requires the expected bridge version/tag with no active migration token");
  }
  return status;
}

function requirePauseOwner(state: MigrationSetupClientState, status: MigrationAdminStatus): void {
  if (status.admission?.state !== "paused" || status.admission.pause_id !== state.request.pause_id || status.progress || status.bootstrap || status.quiescence) {
    throw new Error("Migration setup requires its current unmigrated pause owner");
  }
}

async function pauseReadyAdmission(journal: MigrationSetupJournal, effects: MigrationSetupEffects): Promise<void> {
  const state = loadSetup(journal, effects);
  if (state.phase !== "admission_ready") throw new Error("Pause outcome is unknown or already consumed; never replay its POST");
  const status = requireBridge(state, await effects.status());
  if (!status.admission || status.admission.state !== "open" && (status.admission.state !== "paused" || status.admission.pause_id !== state.request.pause_id)) {
    throw new Error("Migration setup cannot pause another admission owner");
  }
  journal.save({ ...state, phase: "pause_requested" });
  await effects.pause();
  journal.save({ ...state, phase: "paused" });
}

export async function runMigrationSetupPause(journal: MigrationSetupJournal, effects: MigrationSetupEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = loadSetup(journal, effects);
    if (state.phase !== "prepared") throw new Error("Migration setup start may already be consumed; inspect state without automatic replay");
    const status = requireBridge(state, await effects.status());
    if (status.admission && status.admission.state !== "open" && (status.admission.state !== "paused" || status.admission.pause_id !== state.request.pause_id)) {
      throw new Error("Migration setup cannot initialize another admission owner");
    }
    journal.save({ ...state, phase: "admission_requested" });
    await effects.initialize();
    journal.save({ ...state, phase: "admission_ready" });
    await pauseReadyAdmission(journal, effects);
  });
}

export async function resumeMigrationSetupPause(journal: MigrationSetupJournal, effects: MigrationSetupEffects): Promise<void> {
  await journal.exclusively(async () => { await pauseReadyAdmission(journal, effects); });
}

export async function runMigrationSetupClaim(journal: MigrationSetupJournal, effects: MigrationSetupEffects): Promise<void> {
  await journal.exclusively(async () => {
    const state = loadSetup(journal, effects);
    if (state.phase !== "paused") throw new Error("Migration claim outcome is unknown or already consumed; never replay its POST");
    const status = requireBridge(state, await effects.status());
    requirePauseOwner(state, status);
    if (status.admission!.invocations.length) throw new Error("Service has live mutating invocations; keep the pause and wait for explicit drain");
    const claim = serviceMigrationRequestSchema.parse({ schema_version: 1, service_id: state.request.bridge.service_id,
      migration_id: state.request.migration_id, pause_id: state.request.pause_id, created_at: state.request.created_at,
      expected_service_generation: status.admission!.generation });
    journal.save({ ...state, phase: "claim_requested", claim });
    await effects.claim(claim);
    journal.save({ ...state, phase: "claimed", claim });
  });
}

export async function runMigrationSetupQuiescence(journal: MigrationSetupJournal, effects: MigrationSetupEffects, input: MigrationQuiescence): Promise<void> {
  const confirmation = migrationQuiescenceSchema.parse(input);
  await journal.exclusively(async () => {
    const state = loadSetup(journal, effects);
    if (state.phase !== "claimed" || !state.claim) throw new Error("Quiescence outcome is unknown or already consumed; never replay its POST");
    if (confirmation.service_id !== state.request.bridge.service_id || confirmation.migration_id !== state.request.migration_id ||
      confirmation.bridge_worker_version_id !== state.request.bridge.worker_version_id || confirmation.request_sha256 !== migrationPayloadHash(state.claim)) {
      throw new Error("Quiescence input differs from the frozen migration claim/bridge");
    }
    const status = requireBridge(state, await effects.status());
    if (status.admission?.state !== "migrating" || status.admission.pause_id !== state.request.pause_id ||
      status.admission.migration!.migration_id !== state.request.migration_id || status.admission.migration!.request_sha256 !== confirmation.request_sha256 ||
      status.progress || status.bootstrap || status.quiescence && JSON.stringify(status.quiescence) !== JSON.stringify(confirmation)) {
      throw new Error("Quiescence requires its uninitialized migration owner and matching frozen declaration");
    }
    journal.save({ ...state, phase: "quiescence_requested", quiescence: confirmation });
    await effects.confirm(confirmation);
    journal.save({ ...state, phase: "quiesced", quiescence: confirmation });
  });
}

export async function inspectMigrationSetup(journal: MigrationSetupJournal, effects: MigrationSetupEffects):
  Promise<{ client_state: MigrationSetupClientState; server_status: MigrationAdminStatus }> {
  return journal.exclusively(async () => {
    const state = loadSetup(journal, effects);
    return { client_state: state, server_status: requireIdentity(state, await effects.status()) };
  });
}

export function createMigrationSetupEffects(input: ServiceConfig, setupInput: MigrationSetupRequest, adminKey: string,
  dependencies: { client?: MigrationAdminClient } = {}): MigrationSetupEffects {
  const config = serviceConfigSchema.parse(input);
  const setup = migrationSetupRequestSchema.parse(setupInput);
  const bridge = setup.bridge;
  if (bridge.service_id !== config.service_id || bridge.account_id !== config.account_id || bridge.worker_name !== config.worker_name) {
    throw new Error("Migration setup effects target another service/account/Worker");
  }
  const client = dependencies.client ?? new MigrationAdminClient(config, adminKey);
  return { request: setup, status: () => client.status(), initialize: () => client.initializeAdmission(bridge), pause: () => client.pauseAdmission(bridge, setup.pause_id),
    claim: async (input) => {
      const request = serviceMigrationRequestSchema.parse(input);
      if (request.migration_id !== setup.migration_id || request.pause_id !== setup.pause_id || request.created_at !== setup.created_at) {
        throw new Error("Migration setup effect received another frozen claim");
      }
      await client.claimMigration(bridge, request);
    },
    confirm: async (input) => {
      const confirmation = migrationQuiescenceSchema.parse(input);
      if (confirmation.migration_id !== setup.migration_id) throw new Error("Migration setup effect received another declaration owner");
      await client.confirmQuiescence(bridge, confirmation);
    },
  };
}
