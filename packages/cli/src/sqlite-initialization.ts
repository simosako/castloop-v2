import { z } from "zod";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { administratorKey } from "./administrator-key";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { createLocalJournalStorage } from "./local-journal-storage";
import type { LocalJournalStorage } from "./local-journal-storage";
import { protectLocalState } from "./workspace-protection";
import type { R2RestOptions } from "./verified-r2-put";
import { sha256HexSync as digest } from "./sha256";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
const stateSchema = z.object({ protocol: z.literal("sqlite-sequential-v1"), operation_id: z.uuid(), service_config_sha256: hash,
  worker_source_sha256: hash, worker_metadata_sha256: hash,
  phase: z.enum(["prepared", "bucket_requested", "bucket_created", "config_requested", "config_uploaded", "worker_requested", "worker_created",
    "deploy_requested", "deployed", "access_requested", "access_enabled", "verified", "setup_requested", "ready"]),
  receipt: receiptSchema.optional(), namespace_id: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().superRefine((value, context) => {
  if (["deployed", "access_requested", "access_enabled", "verified", "setup_requested", "ready"].includes(value.phase) !== (value.receipt !== undefined) ||
    ["verified", "setup_requested", "ready"].includes(value.phase) !== (value.namespace_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Initialization phase and deployment evidence differ" });
  }
});
export type SqliteInitializationState = z.infer<typeof stateSchema>;
const local = (root: string, config: SqliteServiceConfig) => createLocalJournalStorage(root, "sqlite-initializations", config.service_id, "initialize.json");

export function readSqliteInitialization(root: string, config: SqliteServiceConfig): SqliteInitializationState | null {
  try { return stateSchema.parse(local(root, config).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function initializeSqliteService(root: string, configInput: SqliteServiceConfig, operationId: string, source: string,
  options: R2RestOptions, wait: { delay: () => Promise<void>; attempts: number } = { delay: () => Bun.sleep(1000), attempts: 120 }): Promise<SqliteInitializationState> {
  const config = sqliteServiceConfigSchema.parse(configInput);
  protectLocalState(root);
  const key = administratorKey(root, true);
  if (!Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid SQLite initialization observation limit");
  const initial = stateSchema.parse({ protocol: "sqlite-sequential-v1", operation_id: operationId, phase: "prepared",
    service_config_sha256: await sqliteServiceConfigHash(config), worker_source_sha256: digest(source),
    worker_metadata_sha256: digest(JSON.stringify(buildSqliteWorkerMetadata(config, key))) });
  const journal = local(root, config); journal.initialize(initial);
  return journal.exclusively(async () => {
    let state = stateSchema.parse(journal.read());
    for (const field of ["operation_id", "service_config_sha256", "worker_source_sha256", "worker_metadata_sha256"] as const) {
      if (state[field] !== initial[field]) throw new Error("SQLite initialization differs from its frozen identity; preserve the journal");
    }
    if (state.phase === "ready") return state;
    if (state.phase !== "prepared") throw new Error("SQLite initialization already started; use read-only init-reconcile only for a completed matching setup, never replay unknown mutations");
    const api = new SqliteCloudflareApi(config, options), client = new SqliteServiceClient(config, key, options.transport);
    const save = (phase: SqliteInitializationState["phase"], fields: Partial<SqliteInitializationState> = {}) => {
      state = stateSchema.parse({ ...state, ...fields, phase }); journal.replace(state);
    };
    await api.preflight();
    save("bucket_requested"); await api.createBucket(); save("bucket_created");
    save("config_requested"); await api.uploadConfig(); save("config_uploaded");
    save("worker_requested"); await api.createWorker(); save("worker_created");
    save("deploy_requested"); const receipt = await api.deploy(source, key); save("deployed", { receipt });
    save("access_requested"); await api.enableAccess(receipt.worker_version_id); save("access_enabled");
    return completeSqliteSetup(journal, state, api, client, wait);
  });
}

async function completeSqliteSetup(journal: LocalJournalStorage, input: SqliteInitializationState, api: SqliteCloudflareApi,
  client: SqliteServiceClient, wait: { attempts: number; delay: () => Promise<void> }): Promise<SqliteInitializationState> {
  let state = input;
  if (!["access_enabled", "verified"].includes(state.phase) || !state.receipt) throw new Error("SQLite setup has no acknowledged deployment/access evidence");
  const receipt = state.receipt, evidence = await api.inspect(receipt);
  if (state.namespace_id && state.namespace_id !== evidence.namespace_id) throw new Error("SQLite setup namespace changed");
  const save = (phase: SqliteInitializationState["phase"], fields: Partial<SqliteInitializationState> = {}) => {
    state = stateSchema.parse({ ...state, ...fields, phase }); journal.replace(state);
  };
  save("verified", { namespace_id: evidence.namespace_id });
  let reachable = false;
  for (let index = 0; index < wait.attempts; index++) {
    try { const health = await client.health();
      if (health.worker_version_id !== receipt.worker_version_id || health.state !== "paused" || !health.drained || health.setup !== null || health.publication_ready) throw new Error("Unexpected fresh runtime");
      reachable = true; break;
    } catch { if (index + 1 < wait.attempts) await wait.delay(); }
  }
  if (!reachable) throw new Error("Expected fresh paused SQLite runtime was not verified; no setup was submitted");
  const request = { operation_id: state.operation_id, service_id: api.config.service_id, worker_version_id: receipt.worker_version_id,
    service_config_sha256: state.service_config_sha256 };
  save("setup_requested");
  try { await client.prepare(request); }
  catch { console.error(JSON.stringify({ event: "sqlite_initialization", operation_id: state.operation_id, reason_code: "setup_submission_unconfirmed" })); }
  for (let index = 0; index < wait.attempts; index++) {
    const health = await client.health();
    if (health.worker_version_id !== receipt.worker_version_id || health.setup && health.setup.operation_id !== state.operation_id ||
      health.state !== "paused" || !health.drained) throw new Error("SQLite initialization runtime differs; no automatic replay");
    if (health.setup?.state === "blocked") throw new Error("SQLite runtime probe is blocked; preserve initialization evidence");
    if (health.publication_ready && health.setup?.state === "ready") {
      await api.inspect(receipt); save("ready"); return state;
    }
    if (index + 1 < wait.attempts) await wait.delay();
  }
  throw new Error("SQLite runtime setup remains unconfirmed; preserve the journal without resending");
}

export async function continueSqliteInitialization(root: string, config: SqliteServiceConfig, operationId: string, source: string,
  options: R2RestOptions, wait: { attempts: number; delay: () => Promise<void> } = { attempts: 120, delay: () => Bun.sleep(1000) }): Promise<SqliteInitializationState> {
  if (!Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid SQLite initialization observation limit");
  const journal = local(root, config), key = administratorKey(root);
  return journal.exclusively(async () => {
    const state = stateSchema.parse(journal.read());
    if (state.operation_id !== operationId || state.service_config_sha256 !== await sqliteServiceConfigHash(config) ||
      state.worker_source_sha256 !== digest(source) || state.worker_metadata_sha256 !== digest(JSON.stringify(buildSqliteWorkerMetadata(config, key))) ||
      !["access_enabled", "verified"].includes(state.phase)) throw new Error("SQLite continuation requires the exact acknowledged deployment before its first setup submission; unknown mutations are not replayed");
    return completeSqliteSetup(journal, state, new SqliteCloudflareApi(config, options), new SqliteServiceClient(config, key, options.transport), wait);
  });
}

export async function reconcileSqliteInitialization(root: string, config: SqliteServiceConfig, operationId: string,
  options: R2RestOptions): Promise<SqliteInitializationState> {
  const journal = local(root, config), key = administratorKey(root);
  return journal.exclusively(async () => {
    const state = stateSchema.parse(journal.read());
    if (state.operation_id !== operationId || state.service_config_sha256 !== await sqliteServiceConfigHash(config) ||
      !["setup_requested", "ready"].includes(state.phase) || !state.receipt || !state.namespace_id) throw new Error("SQLite initialization has no reconcilable completed-runtime identity");
    const api = new SqliteCloudflareApi(config, options), health = await new SqliteServiceClient(config, key, options.transport).health();
    if (!health.publication_ready || health.setup?.operation_id !== operationId || health.setup.state !== "ready" || health.state !== "paused" ||
      !health.drained || health.worker_version_id !== state.receipt.worker_version_id ||
      (await api.inspect(state.receipt)).namespace_id !== state.namespace_id) throw new Error("SQLite setup completion was not verified without mutation");
    const ready = stateSchema.parse({ ...state, phase: "ready" }); journal.replace(ready); return ready;
  });
}
