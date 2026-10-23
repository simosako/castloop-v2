import { z } from "zod";
import { stringifyToml } from "@castloop/shared";
import { parseSqliteDomainRequest, requireSqliteDomainConnection, SQLITE_DOMAIN_PROTOCOL, sqliteDomainConnectionSchema, sqliteDomainRequestHash } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { administratorKey } from "./administrator-key";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqliteDomainClient } from "./sqlite-domain-client";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";
import { readSqliteDomainJournal, sqliteDomainJournal, sqliteDomainJournalSchema } from "./sqlite-domain-journal";
import type { SqliteDomainJournal } from "./sqlite-domain-journal";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { loadWorkspaceConfig } from "./workspace-config";
import { requireSettledSqliteDomainDrafts } from "./sqlite-draft-journal";
import { pendingLocalDomainChanges } from "./sqlite-domain-local";
import { sha256HexSync } from "./sha256";
import type { R2RestOptions } from "./verified-r2-put";
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
  requireSettledSqliteDomainDrafts(root, config);
  if (readSqliteDomainJournal(root, config, operationId)) throw new Error("Domain operation already exists; inspect or continue it explicitly without replay");
  if (pendingLocalDomainChanges(root, config).length) throw new Error("Preserve unfinished domain operations and client locks; inspect the same operation without replacement");
  const key = administratorKey(root), client = new SqliteServiceClient(config, key, options.transport);
  const domain = new SqliteDomainClient(config, key, options.transport), cloudflare = new SqliteDomainCloudflare(config, options);
  const health = await client.health(), known = await domain.state();
  if (!health.publication_ready || health.state !== "paused" || !health.drained || known.maintenance ||
    JSON.stringify(known.runtime) !== JSON.stringify({ service_id: config.service_id, worker_version_id: health.worker_version_id,
      service_config_sha256: health.service_config_sha256 })) throw new Error("Explicitly pause and drain every ready Show before a domain change");
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
  if (previous.worker_version_id !== health.worker_version_id) throw new Error("Domain previous REST and native versions differ");
  const request = await parseSqliteDomainRequest({ schema_version: 1, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: operationId, action,
    ...zone, namespace_id: previous.namespace_id, previous_config: config, target_config: next,
    previous_runtime: { service_id: config.service_id, worker_version_id: health.worker_version_id, service_config_sha256: health.service_config_sha256 },
    target_config_sha256: await sqliteServiceConfigHash(next), worker_source_sha256: sha256HexSync(sourceFor(source, operationId)),
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
      ![request.previous_runtime.service_config_sha256, request.target_config_sha256].includes(localHash) ||
      sha256HexSync(sourceFor(source, id)) !== request.worker_source_sha256 ||
       sha256HexSync(JSON.stringify(buildSqliteWorkerMetadata(request.target_config, key))) !== request.worker_metadata_sha256) throw new Error("Domain continuation differs from its frozen input; preserve the journal");
    if (["local_synced", "detach_requested", "detached", "finalize_requested", "completed"].includes(state.phase) && localHash !== request.target_config_sha256) {
      throw new Error("Local configuration differs from the acknowledged domain synchronization; preserve the journal");
    }
    const client = new SqliteDomainClient(request.previous_config, key, options.transport);
    const previousApi = new SqliteCloudflareApi(request.previous_config, options), api = new SqliteCloudflareApi(request.target_config, options);
    const domains = new SqliteDomainCloudflare(request.previous_config, options);
    const save = (phase: SqliteDomainJournal["phase"], fields: Partial<SqliteDomainJournal> = {}) => {
      state = sqliteDomainJournalSchema.parse({ ...state, ...fields, phase }); journal.replace(state);
    };
    const exactRemote = async () => {
      const result = await client.status(request);
      if (state.activation && JSON.stringify(result.own.activation) !== JSON.stringify(state.activation)) throw new Error("Remote domain activation receipt differs");
      if (state.receipt && (result.own.actual_runtime.worker_version_id !== state.receipt.worker_version_id ||
        result.own.actual_runtime.service_config_sha256 !== request.target_config_sha256)) throw new Error("Remote domain native runtime differs");
      return result;
    };
    if (state.phase === "completed") return state;
    if (["connection_requested", "config_requested", "deploy_requested", "detach_requested"].includes(state.phase)) throw new Error("A Cloudflare domain mutation has an unknown outcome; inspect without replay or adoption");
    if (state.phase === "prepare_requested") {
      const result = await client.status(request);
      if (result.phase !== "prepared" || result.prepared_count !== result.target_count || result.own.phase !== "prepared") throw new Error("Domain preparation remains partial or uncertain; never resend it");
      save("maintenance");
    }
    if (state.phase === "prepared") {
      await previousApi.inspect(state.previous); save("prepare_requested"); await client.prepare(request); save("maintenance");
    }
    if (state.phase === "maintenance") {
      await previousApi.inspect(state.previous);
      if (request.action === "add") {
        save("connection_requested"); const connection = await domains.attach(request); save("connected", { connection });
      } else save("connected", { connection: request.connection! });
    }
    if (state.connection) requireSqliteDomainConnection(state.connection, request);
    if (state.phase === "connected") {
      await domains.inspect(request, state.connection!);
      await domains.verifyTls(request.action === "add" ? request.target_config.public_base_url : request.previous_config.workers_dev_base_url);
      await previousApi.inspect(state.previous);
      save("config_requested"); await api.uploadConfig(); save("configured");
    }
    if (state.phase === "configured") {
      await previousApi.inspect(state.previous); await domains.inspect(request, state.connection!);
      save("deploy_requested"); const upload = await api.uploadWorker(sourceFor(source, id), key); save("deploy_acknowledged", { upload_receipt: upload });
    }
    if (state.phase === "deploy_acknowledged") save("deployed", { receipt: await api.deploymentReceipt(state.upload_receipt!) });
    if (["deployed", "verified"].includes(state.phase)) {
      if ((await api.inspect(state.receipt!)).namespace_id !== request.namespace_id) throw new Error("Domain deployment changed its namespace");
      save("verified"); let ready = false;
      for (let attempt = 0; attempt < wait.attempts; attempt++) {
        const health = await client.nativeHealth();
        const old = health.worker_version_id === request.previous_runtime.worker_version_id && health.service_config_sha256 === request.previous_runtime.service_config_sha256;
        const current = health.worker_version_id === state.receipt!.worker_version_id && health.service_config_sha256 === request.target_config_sha256;
        if (!old && !current) throw new Error("Domain native runtime differs from its exact old/new deployment");
        if (current && (await client.status(request)).targets_native_ready) { ready = true; break; }
        if (attempt + 1 < wait.attempts) await wait.delay();
      }
      if (!ready) throw new Error("Domain native rollout remains pending; continue observation explicitly without redeploying");
      if ((await api.inspect(state.receipt!)).namespace_id !== request.namespace_id) throw new Error("Domain namespace changed before activation");
      await domains.inspect(request, state.connection!);
      save("activation_requested", { activation: { operation_id: id, request_sha256: state.request_sha256,
        worker_version_id: state.receipt!.worker_version_id, deployment_id: state.receipt!.deployment_id,
        script_etag: state.receipt!.script_etag, connection: state.connection! } });
      await client.activate(state.activation!, request); save("probing");
    }
    if (state.phase === "activation_requested") {
      const result = await exactRemote();
      if (!["probing", "completed"].includes(result.phase)) throw new Error("Domain activation is incomplete or uncertain; never resend it");
      save("probing");
    }
    if (state.phase === "probing") {
      let complete = false;
      for (let attempt = 0; attempt < wait.attempts; attempt++) {
        const result = await exactRemote();
        if (result.own.phase === "blocked" || result.blocked_count > 0) throw new Error("Domain Feed or runtime probe is blocked; preserve its exact operation");
        if (result.all_completed) { complete = true; break; }
        if (attempt + 1 < wait.attempts) await wait.delay();
      }
      if (!complete) throw new Error("Domain probes remain pending; continue read-only observation without replay");
      save("remote_ready");
    }
    if (state.phase === "remote_ready") {
      if (!(await exactRemote()).all_completed || (await api.inspect(state.receipt!)).namespace_id !== request.namespace_id) throw new Error("Domain completion differs before local synchronization");
      await domains.inspect(request, state.connection!);
      const currentHash = await sqliteServiceConfigHash(await loadWorkspaceConfig(root));
      if (currentHash !== request.target_config_sha256) {
        if (currentHash !== request.previous_runtime.service_config_sha256) throw new Error("Local configuration changed; never overwrite unrelated edits");
        const file = join(root, "castloop.toml"), temporary = join(root, `.castloop-domain-${id}-${crypto.randomUUID()}.tmp`);
        writeSyncedLocalFile(temporary, () => stringifyToml(request.target_config));
        if (await sqliteServiceConfigHash(await loadWorkspaceConfig(root)) !== currentHash) throw new Error("Local configuration changed during synchronization");
        renameSync(temporary, file); syncLocalJournalDirectory(root);
      }
      save("local_synced");
    }
    if (state.phase === "local_synced" && request.action === "remove") {
      if (!(await exactRemote()).all_completed) throw new Error("Domain restoration is incomplete");
      await domains.verifyTls(request.target_config.workers_dev_base_url);
      save("detach_requested"); await domains.detach(request, state.connection!); save("detached", { detach_acknowledged: true });
    }
    if (state.phase === "local_synced" || state.phase === "detached") {
      if (!(await exactRemote()).all_completed) throw new Error("Domain probes are not all complete");
      if (request.action === "add") await domains.inspect(request, state.connection!);
      save("finalize_requested");
      await client.finalize({ operation_id: id, request_sha256: state.request_sha256, connection: state.connection!, detached: request.action === "remove" }, request);
      save("completed");
    }
    if (state.phase === "finalize_requested") {
      const result = await exactRemote();
      if (result.phase !== "completed" || !result.all_completed || result.released_count !== result.target_count) throw new Error("Domain finalization remains uncertain; never resend it");
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
