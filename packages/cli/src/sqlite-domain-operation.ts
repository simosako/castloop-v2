import { z } from "zod";
import { stringifyToml } from "@castloop/shared";
import { parseSqliteDomainRequest, requireSqliteDomainConnection, SQLITE_DOMAIN_PROTOCOL, sqliteDomainConnectionSchema, sqliteDomainRequestHash } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { administratorKey } from "./administrator-key";
import { AgentError } from "./agent-output";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqliteDomainClient } from "./sqlite-domain-client";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";
import { readSqliteDomainJournal, sqliteDomainJournal, sqliteDomainJournalSchema } from "./sqlite-domain-journal";
import type { SqliteDomainJournal } from "./sqlite-domain-journal";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { loadWorkspaceConfig } from "./workspace-config";
import { pendingLocalDomainChanges } from "./sqlite-domain-local";
import { sha256HexSync } from "./sha256";
import type { R2RestOptions } from "./bounded-http-read";
import { renameSync } from "node:fs";
import { join } from "node:path";

type DomainWait = { attempts: number; delay: () => Promise<void> };
const defaultWait: DomainWait = { attempts: 120, delay: () => Bun.sleep(1000) };
const sourceFor = (source: string, id: string) => `${source}\n// castloop SQLite domain operation: ${id}\n`;

export async function startSqliteDomainChange(root: string, config: SqliteServiceConfig,
  action: "add" | "remove", operationId: string, source: string, options: R2RestOptions,
  target?: { hostname: string; zoneId: string }, wait = defaultWait): Promise<SqliteDomainJournal> {
  config = sqliteServiceConfigSchema.parse(config); z.uuid().parse(operationId);
  if (!source) throw new Error("Domain changes require the embedded Worker source");
  if (readSqliteDomainJournal(root, config, operationId)) throw new Error("Domain operation already exists; inspect or continue it explicitly without replay");
  if (pendingLocalDomainChanges(root, config).length) throw new Error("Preserve unfinished domain operations and client locks; inspect the same operation without replacement");
  const key = administratorKey(root), client = new SqliteServiceClient(config, key, options.transport);
  const domain = new SqliteDomainClient(config, key, options.transport), cloudflare = new SqliteDomainCloudflare(config, options);
  const health = await client.health(), known = await domain.state();
  if (!health.publication_ready || known.pending ||
    known.runtime.service_config_sha256 !== health.service_config_sha256 ||
    health.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Domain change requires a ready service on the exact current configuration");
  const connection = known.connection;
  let zone: { hostname: string; zone_id: string; zone_name: string };
  if (action === "add") {
    if (!target || connection || config.public_base_url !== config.workers_dev_base_url) throw new Error("Add requires a new dedicated hostname and workers.dev canonical origin");
    zone = await cloudflare.preflightAdd(target.hostname, target.zoneId);
  } else {
    if (target || !connection || config.public_base_url !== `https://${connection.hostname}`) throw new Error("Remove requires the exact known canonical domain connection");
    zone = { hostname: connection.hostname, zone_id: connection.zone_id, zone_name: connection.zone_name };
  }
  const next = { ...config, public_base_url: action === "add" ? `https://${zone.hostname}` : config.workers_dev_base_url };
  const api = new SqliteCloudflareApi(config, options), previous = await api.current();
  const request = await parseSqliteDomainRequest({ schema_version: 1, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: operationId, action,
    ...zone, namespace_id: previous.namespace_id, previous_config: config, previous_config_sha256: await sqliteServiceConfigHash(config),
    target_config: next, target_config_sha256: await sqliteServiceConfigHash(next),
    worker_source_sha256: sha256HexSync(sourceFor(source, operationId)),
    worker_metadata_sha256: sha256HexSync(JSON.stringify(buildSqliteWorkerMetadata(next, key))), ...(action === "remove" ? { connection } : {}) });
  if (connection) await cloudflare.inspect(request, connection);
  const journal = sqliteDomainJournal(root, config, operationId);
  journal.initialize(sqliteDomainJournalSchema.parse({ schema_version: 1, request, request_sha256: await sqliteDomainRequestHash(request), previous, phase: "prepared" }));
  return continueSqliteDomainChange(root, config, operationId, source, options, wait);
}

export async function continueSqliteDomainChange(root: string, config: SqliteServiceConfig, id: string,
  source: string, options: R2RestOptions, wait = defaultWait): Promise<SqliteDomainJournal> {
  config = sqliteServiceConfigSchema.parse(config);
  if (!Number.isSafeInteger(wait.attempts) || wait.attempts < 1 || wait.attempts > 120) throw new Error("Invalid finite domain observation budget");
  const journal = sqliteDomainJournal(root, config, id), key = administratorKey(root);
  return journal.exclusively(async () => {
    let state = sqliteDomainJournalSchema.parse(journal.read());
    const request = await parseSqliteDomainRequest(state.request), localHash = await sqliteServiceConfigHash(await loadWorkspaceConfig(root));
    if (request.operation_id !== id || request.previous_config.service_id !== config.service_id ||
      state.request_sha256 !== await sqliteDomainRequestHash(request) ||
      ![request.previous_config_sha256, request.target_config_sha256].includes(localHash) ||
      sha256HexSync(sourceFor(source, id)) !== request.worker_source_sha256 ||
       sha256HexSync(JSON.stringify(buildSqliteWorkerMetadata(request.target_config, key))) !== request.worker_metadata_sha256) throw new Error("Domain continuation differs from its frozen input; preserve the journal");
    if (["local_synced", "completed"].includes(state.phase) && localHash !== request.target_config_sha256) {
      throw new Error("Local configuration differs from the acknowledged domain synchronization; preserve the journal");
    }
    const client = new SqliteDomainClient(request.previous_config, key, options.transport);
    const previousApi = new SqliteCloudflareApi(request.previous_config, options), api = new SqliteCloudflareApi(request.target_config, options);
    const domains = new SqliteDomainCloudflare(request.previous_config, options);
    const save = (phase: SqliteDomainJournal["phase"], fields: Partial<SqliteDomainJournal> = {}) => {
      state = sqliteDomainJournalSchema.parse({ ...state, ...fields, phase }); journal.replace(state);
    };
    if (state.phase === "completed") return state;
    if (state.phase === "prepared") {
      await previousApi.inspect(state.previous);
      await client.prepare(request);
      const connection = request.action === "add" ? await domains.attach(request) : request.connection!;
      save("connected", { connection });
    }
    if (state.connection) requireSqliteDomainConnection(state.connection, request);
    if (state.phase === "connected") {
      await domains.inspect(request, state.connection!);
      await domains.verifyTls(request.action === "add" ? request.target_config.public_base_url : request.previous_config.workers_dev_base_url);
      await previousApi.inspect(state.previous);
      await api.uploadConfig();
      const upload = await api.uploadWorker(sourceFor(source, id), key);
      const receipt = await api.deploymentReceipt(upload);
      save("deployed", { receipt });
    }
    if (state.phase === "deployed") {
      if ((await api.inspect(state.receipt!)).namespace_id !== request.namespace_id) throw new Error("Domain deployment changed its namespace");
      let ready = false;
      for (let attempt = 0; attempt < wait.attempts; attempt++) {
        const health = await client.nativeHealth();
        const current = health.worker_version_id === state.receipt!.worker_version_id && health.service_config_sha256 === request.target_config_sha256;
        if (current) { ready = true; break; }
        if (health.service_config_sha256 !== request.previous_config_sha256) throw new Error("Domain native runtime differs from its exact old/new deployment");
        if (attempt + 1 < wait.attempts) await wait.delay();
      }
      if (!ready) throw new AgentError("domain_rollout_pending", "Domain native rollout remains pending; continue observation explicitly without redeploying");
      await domains.inspect(request, state.connection!);
      await client.commit({ operation_id: id, request_sha256: state.request_sha256,
        worker_version_id: state.receipt!.worker_version_id, deployment_id: state.receipt!.deployment_id,
        script_etag: state.receipt!.script_etag, connection: state.connection! }, request);
      save("remote_ready");
    }
    if (state.phase === "remote_ready") {
      if (!(await client.status(request)).all_completed || (await api.inspect(state.receipt!)).namespace_id !== request.namespace_id) throw new Error("Domain completion differs before local synchronization");
      await domains.inspect(request, state.connection!);
      const currentHash = await sqliteServiceConfigHash(await loadWorkspaceConfig(root));
      if (currentHash !== request.target_config_sha256) {
        if (currentHash !== request.previous_config_sha256) throw new Error("Local configuration changed; never overwrite unrelated edits");
        const file = join(root, "castloop.toml"), temporary = join(root, `.castloop-domain-${id}-${crypto.randomUUID()}.tmp`);
        writeSyncedLocalFile(temporary, () => stringifyToml(request.target_config));
        if (await sqliteServiceConfigHash(await loadWorkspaceConfig(root)) !== currentHash) throw new Error("Local configuration changed during synchronization");
        renameSync(temporary, file); syncLocalJournalDirectory(root);
      }
      save("local_synced");
    }
    if (state.phase === "local_synced") {
      if (!(await client.status(request)).all_completed) throw new Error("Domain commits are not all complete");
      if (request.action === "remove") {
        await domains.verifyTls(request.target_config.workers_dev_base_url);
        await domains.detach(request, state.connection!);
      } else {
        await domains.inspect(request, state.connection!);
      }
      await client.finalize({ operation_id: id, request_sha256: state.request_sha256, connection: state.connection!, detached: request.action === "remove" }, request);
      save("completed");
    }
    return state;
  });
}

export async function listSqliteDomains(root: string, config: SqliteServiceConfig, options: R2RestOptions) {
  const local = pendingLocalDomainChanges(root, config);
  const state = await new SqliteDomainClient(config, administratorKey(root), options.transport).state();
  const domains = (await new SqliteDomainCloudflare(config, options).list()).filter((domain) => domain.service === config.worker_name);
  const current = domains.length === 1 ? sqliteDomainConnectionSchema.safeParse(domains[0]) : null;
  return { management_origin: config.workers_dev_base_url, canonical_origin: config.public_base_url, state, domains, local_pending: local,
    configuration_matches: state.runtime.service_config_sha256 === await sqliteServiceConfigHash(config),
    connections_match: state.connection ? current?.success === true && JSON.stringify(current.data) === JSON.stringify(state.connection) && config.public_base_url === `https://${state.connection.hostname}` :
      domains.length === 0 && config.public_base_url === config.workers_dev_base_url };
}

export async function sqliteDomainOperationStatus(root: string, config: SqliteServiceConfig, id: string,
  options: R2RestOptions, after = "") {
  const state = readSqliteDomainJournal(root, config, id);
  if (!state) throw new Error("Domain operation journal is missing; unknown remote operations cannot be adopted");
  const request = await parseSqliteDomainRequest(state.request);
  if (state.request_sha256 !== await sqliteDomainRequestHash(request)) throw new Error("Domain journal hash differs");
  return { local_phase: state.phase, remote: await new SqliteDomainClient(request.previous_config, administratorKey(root), options.transport).status(request, after) };
}
