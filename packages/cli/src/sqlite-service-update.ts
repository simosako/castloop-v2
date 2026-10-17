import { z } from "zod";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteUpdatePrepareSchema } from "../../shared/src/sqlite-runtime-update";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { administratorKey } from "./administrator-key";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { createLocalJournalStorage } from "./local-journal-storage";
import type { LocalJournalStorage } from "./local-journal-storage";
import type { R2RestOptions } from "./verified-r2-put";
import { sha256HexSync as digest } from "./sha256";

const receipt = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
const evidence = receipt.extend({ namespace_id: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
const stateSchema = z.object({ protocol: z.literal("sqlite-sequential-v1"), request: sqliteUpdatePrepareSchema, previous: evidence,
  phase: z.enum(["prepared", "prepare_requested", "maintenance", "deploy_requested", "deployed", "verified", "activation_requested", "ready"]),
  receipt: receipt.optional() }).strict().superRefine((value, context) => {
  if (["deployed", "verified", "activation_requested", "ready"].includes(value.phase) !== (value.receipt !== undefined) ||
    value.previous.worker_version_id !== value.request.worker_version_id || value.previous.namespace_id !== value.request.namespace_id ||
    value.receipt?.worker_version_id === value.request.worker_version_id) context.addIssue({ code: "custom", message: "SQLite update phase and runtime evidence differ" });
});
export type SqliteServiceUpdateState = z.infer<typeof stateSchema>;
type UpdateWait = { attempts: number; delay: () => Promise<void> };
const defaultWait: UpdateWait = { attempts: 120, delay: () => Bun.sleep(1000) };
const local = (root: string, config: SqliteServiceConfig, id: string) => {
  z.uuid().parse(id); return createLocalJournalStorage(root, "sqlite-service-updates", config.service_id, `${id}.json`);
};
export function readSqliteServiceUpdate(root: string, config: SqliteServiceConfig, operationId: string): SqliteServiceUpdateState | null {
  try { return stateSchema.parse(local(root, config, operationId).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function updateSqliteService(root: string, config: SqliteServiceConfig, operationId: string, source: string,
  options: R2RestOptions, wait: UpdateWait = defaultWait): Promise<SqliteServiceUpdateState> {
  if (!source || !Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid SQLite update source or observation limit");
  const key = administratorKey(root), api = new SqliteCloudflareApi(config, options), client = new SqliteServiceClient(config, key, options.transport);
  const journal = local(root, config, operationId), retained = readSqliteServiceUpdate(root, config, operationId);
  const configHash = await sqliteServiceConfigHash(config), metadataHash = digest(JSON.stringify(buildSqliteWorkerMetadata(config, key)));
  if (retained && (retained.request.service_id !== config.service_id || retained.request.service_config_sha256 !== configHash ||
    retained.request.worker_source_sha256 !== digest(source) || retained.request.worker_metadata_sha256 !== metadataHash)) throw new Error("SQLite update differs from its frozen source/configuration");
  if (!retained) {
    const health = await client.health();
    if (!health.publication_ready || health.state !== "paused" || !health.drained) throw new Error("Explicitly pause and drain the ready SQLite service before deployment");
    const previous = await api.current();
    if (previous.worker_version_id !== health.worker_version_id) throw new Error("SQLite REST and DO versions differ");
    journal.initialize(stateSchema.parse({ protocol: "sqlite-sequential-v1", phase: "prepared", previous, request: {
      service_id: config.service_id, service_config_sha256: configHash, worker_version_id: previous.worker_version_id,
      operation_id: operationId, worker_source_sha256: digest(source), worker_metadata_sha256: metadataHash, namespace_id: previous.namespace_id } }));
  }
  return journal.exclusively(async () => {
    let state = stateSchema.parse(journal.read());
    if (state.request.operation_id !== operationId || state.request.service_config_sha256 !== configHash || state.request.worker_source_sha256 !== digest(source) ||
      state.request.worker_metadata_sha256 !== metadataHash) throw new Error("SQLite update journal changed concurrently");
    if (state.phase === "ready") return state;
    if (state.phase !== "prepared") throw new Error("SQLite update already started; preserve unknown outcomes and use read-only update-service-reconcile only for completed matching setup");
    if ((await api.inspect(state.previous)).namespace_id !== state.previous.namespace_id) throw new Error("SQLite previous deployment changed");
    const save = (phase: SqliteServiceUpdateState["phase"], fields: Partial<SqliteServiceUpdateState> = {}) => {
      state = stateSchema.parse({ ...state, ...fields, phase }); journal.replace(state);
    };
    save("prepare_requested");
    const preparation = await client.update("prepare", state.request);
    if (preparation.update.state !== "prepared" || preparation.worker_version_id !== state.request.worker_version_id) throw new Error("SQLite maintenance preparation was not verified");
    save("maintenance");
    await api.inspect(state.previous);
    save("deploy_requested"); const receipt = await api.deploy(source, key); save("deployed", { receipt });
    if ((await api.inspect(receipt)).namespace_id !== state.request.namespace_id) throw new Error("SQLite update changed its namespace; do not activate it");
    save("verified");
    return activateVerifiedUpdate(journal, state, client, api, wait);
  });
}

async function activateVerifiedUpdate(journal: LocalJournalStorage, initial: SqliteServiceUpdateState, client: SqliteServiceClient,
  api: SqliteCloudflareApi, wait: UpdateWait): Promise<SqliteServiceUpdateState> {
  let state = initial;
  if (state.phase !== "verified" || !state.receipt) throw new Error("SQLite activation requires an acknowledged verified deployment with no prior activation request");
  const receipt = state.receipt;
  let nativeVersionVerified = false;
  for (let index = 0; index < wait.attempts; index++) {
    const pending = await client.update("status", state.request);
    if (pending.update.state !== "prepared" || pending.update.new_worker_version_id !== null ||
      ![state.request.worker_version_id, receipt.worker_version_id].includes(pending.worker_version_id)) throw new Error("New SQLite runtime did not retain the exact maintenance request");
    if (pending.worker_version_id === receipt.worker_version_id) { nativeVersionVerified = true; break; }
    console.error(JSON.stringify({ event: "sqlite_service_update", operation_id: state.request.operation_id,
      reason_code: "native_version_pending", attempt: index + 1, maximum_attempts: wait.attempts }));
    if (index + 1 < wait.attempts) await wait.delay();
  }
  if (!nativeVersionVerified) throw new Error("Verified SQLite deployment has not reached the native runtime; preserve the journal and continue verification explicitly without redeploying");
  if ((await api.inspect(receipt)).namespace_id !== state.request.namespace_id) throw new Error("Verified SQLite update namespace changed; do not activate it");
  state = stateSchema.parse({ ...state, phase: "activation_requested" }); journal.replace(state);
  try { await client.update("activate", { ...state.request, new_worker_version_id: receipt.worker_version_id,
    deployment_id: receipt.deployment_id, script_etag: receipt.script_etag }); }
  catch { console.error(JSON.stringify({ event: "sqlite_service_update", operation_id: state.request.operation_id, reason_code: "activation_unconfirmed" })); }
  for (let index = 0; index < wait.attempts; index++) {
    const status = await client.update("status", state.request);
    if (status.worker_version_id !== receipt.worker_version_id || status.update.new_worker_version_id !== receipt.worker_version_id || status.update.state === "blocked") throw new Error("SQLite updated runtime probe is blocked or differs; do not replay activation");
    if (status.update.state === "completed") {
      const health = await client.health();
      if (!health.publication_ready || health.state !== "paused" || !health.drained || health.worker_version_id !== receipt.worker_version_id || health.setup?.operation_id !== state.request.operation_id) throw new Error("SQLite updated runtime readiness was not verified");
      if ((await api.inspect(receipt)).namespace_id !== state.request.namespace_id) throw new Error("SQLite updated namespace changed");
      state = stateSchema.parse({ ...state, phase: "ready" }); journal.replace(state); return state;
    }
    if (index + 1 < wait.attempts) await wait.delay();
  }
  throw new Error("SQLite update remains unconfirmed; inspect without resubmitting");
}

export async function continueSqliteServiceUpdateVerification(root: string, config: SqliteServiceConfig, operationId: string,
  source: string, options: R2RestOptions, wait: UpdateWait = defaultWait): Promise<SqliteServiceUpdateState> {
  if (!source || !Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid SQLite update source or observation limit");
  const journal = local(root, config, operationId), key = administratorKey(root);
  return journal.exclusively(async () => {
    const state = stateSchema.parse(journal.read());
    if (state.phase !== "verified" || !state.receipt || state.request.operation_id !== operationId || state.request.service_id !== config.service_id ||
      state.request.service_config_sha256 !== await sqliteServiceConfigHash(config) || state.request.worker_source_sha256 !== digest(source) ||
      state.request.worker_metadata_sha256 !== digest(JSON.stringify(buildSqliteWorkerMetadata(config, key)))) {
      throw new Error("SQLite update verification continuation requires its exact verified source/configuration and no prior activation request");
    }
    const api = new SqliteCloudflareApi(config, options);
    if ((await api.inspect(state.receipt)).namespace_id !== state.request.namespace_id) throw new Error("Verified SQLite deployment namespace changed");
    return activateVerifiedUpdate(journal, state, new SqliteServiceClient(config, key, options.transport), api, wait);
  });
}

export async function reconcileSqliteServiceUpdate(root: string, config: SqliteServiceConfig, operationId: string,
  options: R2RestOptions): Promise<SqliteServiceUpdateState> {
  const journal = local(root, config, operationId), key = administratorKey(root);
  return journal.exclusively(async () => {
    const state = stateSchema.parse(journal.read());
    if (state.request.operation_id !== operationId || state.request.service_id !== config.service_id || state.request.service_config_sha256 !== await sqliteServiceConfigHash(config) ||
      !["activation_requested", "ready"].includes(state.phase) || !state.receipt) throw new Error("SQLite update has no completed-runtime reconciliation evidence");
    const client = new SqliteServiceClient(config, key, options.transport), status = await client.update("status", state.request), health = await client.health();
    if (status.worker_version_id !== state.receipt.worker_version_id || status.update.state !== "completed" || status.update.new_worker_version_id !== state.receipt.worker_version_id ||
      !health.publication_ready || health.state !== "paused" || !health.drained || health.worker_version_id !== state.receipt.worker_version_id || health.setup?.operation_id !== operationId ||
      (await new SqliteCloudflareApi(config, options).inspect(state.receipt)).namespace_id !== state.request.namespace_id) throw new Error("SQLite update completion was not verified read-only");
    const ready = stateSchema.parse({ ...state, phase: "ready" }); journal.replace(ready); return ready;
  });
}
