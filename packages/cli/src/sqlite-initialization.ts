import { z } from "zod";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { administratorKey } from "./administrator-key";
import { createLocalJournalStorage } from "./local-journal-storage";
import { sha256HexSync as digest } from "./sha256";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import type { R2RestOptions } from "./bounded-http-read";
import { protectLocalState } from "./workspace-protection";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
const stateSchema = z.object({ protocol: z.literal("sqlite-sequential-v1"), operation_id: z.uuid(), service_config_sha256: hash,
  worker_source_sha256: hash, worker_metadata_sha256: hash,
  phase: z.enum(["fresh", "prepared", "deployed", "ready"]),
  receipt: receiptSchema.optional(), namespace_id: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().superRefine((value, context) => {
  if (["deployed", "ready"].includes(value.phase) !== (value.receipt !== undefined) ||
    (value.phase === "ready") !== (value.namespace_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Initialization phase and deployment evidence differ" });
  }
});
export type SqliteInitializationState = z.infer<typeof stateSchema>;
const local = (root: string, config: SqliteServiceConfig) => createLocalJournalStorage(root, "sqlite-initializations", config.service_id, "initialize.json");

export function readSqliteInitialization(root: string, config: SqliteServiceConfig): SqliteInitializationState | null {
  try { return stateSchema.parse(local(root, config).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; }
}

// Each initialization step checks current state and can be safely re-run after an interrupted attempt.
export async function initializeSqliteService(root: string, configInput: SqliteServiceConfig, operationId: string, source: string,
  options: R2RestOptions, wait: { delay: () => Promise<void>; attempts: number } = { delay: () => Bun.sleep(1000), attempts: 120 }): Promise<SqliteInitializationState> {
  const config = sqliteServiceConfigSchema.parse(configInput);
  protectLocalState(root);
  const key = administratorKey(root, true);
  if (!Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid SQLite initialization observation limit");
  const initial = stateSchema.parse({ protocol: "sqlite-sequential-v1", operation_id: operationId, phase: "fresh",
    service_config_sha256: await sqliteServiceConfigHash(config), worker_source_sha256: digest(source),
    worker_metadata_sha256: digest(JSON.stringify(buildSqliteWorkerMetadata(config, key))) });
  const journal = local(root, config);
  if (!readSqliteInitialization(root, config)) journal.initialize(initial);
  return journal.exclusively(async () => {
    let state = stateSchema.parse(journal.read());
    for (const field of ["operation_id", "service_config_sha256", "worker_source_sha256", "worker_metadata_sha256"] as const) {
      if (state[field] !== initial[field]) throw new Error("SQLite initialization differs from its frozen identity; preserve the journal");
    }
    if (state.phase === "ready") return state;
    const api = new SqliteCloudflareApi(config, options), client = new SqliteServiceClient(config, key, options.transport);
    const save = (phase: SqliteInitializationState["phase"], fields: Partial<SqliteInitializationState> = {}) => {
      state = stateSchema.parse({ ...state, ...fields, phase }); journal.replace(state);
    };
    if (state.phase === "fresh") {
      await api.preflight();
      save("prepared");
    }
    if (state.phase === "prepared") {
      await api.createBucket();
      await api.uploadConfig();
      await api.createWorker();
      const upload = await api.uploadWorker(source, key);
      save("deployed", { receipt: await api.deploymentReceipt(upload) });
    }
    if (state.phase === "deployed") {
      await api.enableAccess(state.receipt!.worker_version_id);
      const evidence = await api.inspect(state.receipt!);
      let ready = false;
      for (let index = 0; index < wait.attempts; index++) {
        try {
          const health = await client.health();
          if (health.worker_version_id !== state.receipt!.worker_version_id) throw new Error("Unexpected runtime version");
          if (!health.publication_ready) throw new Error("Service is not ready");
          ready = true; break;
        } catch { if (index + 1 < wait.attempts) await wait.delay(); }
      }
      if (!ready) throw new Error("SQLite service readiness remains unconfirmed; run init again");
      save("ready", { namespace_id: evidence.namespace_id });
    }
    return state;
  });
}
