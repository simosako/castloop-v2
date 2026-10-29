import { z } from "zod";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { administratorKey } from "./administrator-key";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqliteDomainClient } from "./sqlite-domain-client";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";
import type { R2RestOptions } from "./verified-r2-put";

const receiptSchema = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
export type SqliteDeployResult = z.infer<typeof deployResultSchema>;
const deployResultSchema = receiptSchema.extend({ previous_worker_version_id: z.uuid(), namespace_id: z.string().regex(/^[a-f0-9]{32}$/),
  publication_ready: z.literal(true) }).strict();
export type DeployWait = { attempts: number; delay: () => Promise<void> };
const defaultWait: DeployWait = { attempts: 120, delay: () => Bun.sleep(1000) };

async function verifyKnownDomains(config: SqliteServiceConfig, key: string, options: R2RestOptions): Promise<void> {
  const state = await new SqliteDomainClient(config, key, options.transport).state();
  if (state.runtime.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Domain configuration differs during code-only deployment");
  if (state.pending) throw new Error("An unfinished domain change is pending; drive it to completion before deploying");
  await new SqliteDomainCloudflare(config, options).verifyKnown(state.connection);
}

// A code-only deployment is a single idempotent operation: verify the configuration still matches, upload the
// script, confirm the deployment evidence, and wait for the service to report the new version. An interrupted
// deployment is completed by running deploy again; no local journal is kept.
export async function deploySqliteService(root: string, config: SqliteServiceConfig, source: string,
  options: R2RestOptions, wait: DeployWait = defaultWait): Promise<SqliteDeployResult> {
  if (!source || !Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid SQLite deploy source or observation limit");
  const key = administratorKey(root), api = new SqliteCloudflareApi(config, options), client = new SqliteServiceClient(config, key, options.transport);
  const health = await client.healthReport();
  if (health.service_id !== config.service_id || health.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
    throw new Error("Local service configuration differs from the running service; use the domain change procedure to change it");
  }
  await verifyKnownDomains(config, key, options);
  const previous = await api.current();
  const upload = await api.uploadWorker(source, key);
  let receipt: z.infer<typeof receiptSchema> | null = null;
  for (let attempt = 0; attempt < wait.attempts; attempt++) {
    try { receipt = await api.deploymentReceipt(upload); break; }
    catch { if (attempt + 1 === wait.attempts) throw new Error("SQLite deployment was not acknowledged; run deploy again"); await wait.delay(); }
  }
  const evidence = await api.inspect(receipt!);
  let ready = false;
  for (let attempt = 0; attempt < wait.attempts; attempt++) {
    const current = await client.health();
    if (current.worker_version_id === receipt!.worker_version_id) {
      if (!current.publication_ready) throw new Error("SQLite service is not ready on the new version");
      ready = true; break;
    }
    if (attempt + 1 < wait.attempts) await wait.delay();
  }
  if (!ready) throw new Error("SQLite service has not reached the new version; run deploy again to verify");
  return deployResultSchema.parse({ worker_version_id: receipt!.worker_version_id, deployment_id: receipt!.deployment_id,
    script_etag: receipt!.script_etag, previous_worker_version_id: previous.worker_version_id,
    namespace_id: evidence.namespace_id, publication_ready: true });
}
