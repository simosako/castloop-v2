import { stringifyToml } from "@castloop/shared";
import { sqliteServiceConfigHash } from "../../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../../shared/src/sqlite-service";
import { SqlitePublicationContent } from "../../../../src/sqlite-publication-content";
import { SqlitePublicationAlarm } from "../../../../src/sqlite-publication-alarm";
import { createSqlitePublicationExecutor } from "../../../../src/sqlite-publication-executor";
import { SqliteServiceRuntime } from "../../../../src/sqlite-service-runtime";
import { sqlitePublicationFixture } from "../../../../src/test-support/sqlite-publication";
import { sqlitePublicationBucket } from "../../../../src/test-support/sqlite-publication-bucket";
import { SqlitePublicationQueue } from "../../../../src/sqlite-publication-queue";
import { selectSqliteRuntime } from "../../../../src/sqlite-runtime-update";
import { SqliteShowService } from "../../../../src/sqlite-show-service";
import { SqliteServiceControl } from "../../../../src/sqlite-service-control";
import { createSqliteControlHttp } from "../../../../src/sqlite-control-http";
import { administratorKey } from "../administrator-key";
import { sha256HexSync } from "../sha256";
import type { R2RestTransport } from "../verified-r2-put";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function sqliteServiceFixture(input?: SqliteServiceConfig, keyRoot?: string) {
  const root = mkdtempSync("/tmp/opencode/castloop-sqlite-service-");
  const config: SqliteServiceConfig = input ?? { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service", account_id: "a".repeat(32),
    bucket_name: "private-bucket", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  writeFileSync(join(root, "castloop.toml"), stringifyToml(config));
  const queue = sqlitePublicationFixture({ resume: false, runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(), service_config_sha256: await sqliteServiceConfigHash(config) } });
  const objects = sqlitePublicationBucket(), content = new SqlitePublicationContent(queue.storage), purges: string[] = [];
  let actual = queue.runtime, previousVersion = actual.worker_version_id, nativeQueue = queue.queue;
  const nodes = new Map<string, { fixture: ReturnType<typeof sqlitePublicationFixture>; service: SqliteShowService }>();
  const showCalls: Array<{ action: string; showId: string }> = [];
  const faultShow = (action: "initialize" | "prepare" | "activate" | "release", showId: string) => {
    if (faults.lostShow?.action === action && faults.lostShow.showId === showId) throw new Error("Unconfirmed Show RPC");
  };
  let control!: SqliteServiceControl;
  const cache = () => ({ describe: async () => ({ ...actual, cache_enabled: true }), purge: async (id: string) => { purges.push(id); } });
  const openShow = (id: string) => {
    let node = nodes.get(id);
    if (!node) {
      const fixture = sqlitePublicationFixture({ resume: false, runtime: actual });
      node = { fixture, service: new SqliteShowService(fixture.storage, id, actual, config, cache(), objects.bucket, administratorKey(keyRoot ?? root)) };
      nodes.set(id, node);
    }
    return node;
  };
  const boot = () => {
    nativeQueue = new SqlitePublicationQueue(queue.storage, selectSqliteRuntime(queue.storage, actual));
    const runtime = new SqliteServiceRuntime(queue.storage, nativeQueue, content, objects.bucket, config, {
      describe: async () => ({ ...actual, cache_enabled: true }), purge: async (id) => { purges.push(id); } }, actual);
    for (const [id, node] of nodes) node.service = new SqliteShowService(node.fixture.storage, id, actual, config, cache(), objects.bucket, administratorKey(keyRoot ?? root));
    control = new SqliteServiceControl(queue.storage, runtime, (id) => ({
      initialize: async (request) => {
        showCalls.push({ action: "initialize", showId: id });
        const node = openShow(id); await node.service.initialize(request);
        node.fixture.clearAlarm(); await node.service.alarmRuntime().alarm(); faultShow("initialize", id); return node.service.health();
      },
      health: async () => ({ ...openShow(id).service.maintenanceHealth(),
        ...(faults.staleShowVersion === id ? { worker_version_id: previousVersion } : {}) }),
      catalog: async (request) => openShow(id).service.runtime.catalog(request),
      prepare: async (request) => {
        showCalls.push({ action: "prepare", showId: id }); await faults.beforeShowPrepare?.(id);
        const result = openShow(id).service.prepareUpdate(request); faultShow("prepare", id); return result;
      },
      activate: async (request) => {
        showCalls.push({ action: "activate", showId: id });
        const node = openShow(id), result = await node.service.activateUpdate(request);
        if (!faults.deferUpdateProbe) { node.fixture.clearAlarm(); await node.service.alarmRuntime().alarm(); }
        faultShow("activate", id);
        return result;
      },
      release: async (operationId) => {
        showCalls.push({ action: "release", showId: id });
        const result = openShow(id).service.releaseUpdate(operationId); faultShow("release", id); return result;
      },
    }));
    return runtime;
  };
  let runtime = boot();
  const namespaceId = "b".repeat(32);
  let deploymentId = crypto.randomUUID(), etag = "frozen-script-etag";
  let bucketCreated = false, workerCreated = false, metadata: Record<string, unknown> | null = null, access = false;
  const calls: Array<{ method: string; path: string }> = [];
  const faults: { lost?: "bucket" | "config" | "worker" | "deploy" | "access" | "setup" | "register" | "control" | "update-prepare" | "activation";
    lostShow?: { action: "initialize" | "prepare" | "activate" | "release"; showId: string }; beforeShowPrepare?: (showId: string) => Promise<void>;
    staleShowVersion?: string;
    namespace?: boolean; settings?: boolean; existing?: "bucket" | "worker" | "empty"; failPurge?: boolean; afterPublish?: () => Promise<void>;
    afterDeploy?: () => void; deferUpdateProbe?: boolean; missingVersionExports?: boolean; failFirstInspection?: boolean } = {};
  const json = (result: unknown) => Response.json({ success: true, result });
  const settings = (): Record<string, unknown> & { bindings: Array<Record<string, unknown>> } => {
    if (!metadata) throw new Error("Missing deployed settings");
    const bindings = (metadata.bindings as Array<Record<string, unknown>>).map((binding) => {
      if (binding.type === "secret_text") return { name: binding.name, type: binding.type };
      if (binding.type === "durable_object_namespace") return { ...binding, namespace_id: namespaceId };
      return binding;
    });
    const { exports, ...current } = metadata;
    return { ...current, bindings, ...(faults.settings ? { cache_options: { enabled: true, cross_version_cache: true } } : {}) };
  };
  const deployment = () => ({ deployments: [{ id: deploymentId, strategy: "percentage", versions: [{ version_id: actual.worker_version_id, percentage: 100 }] }] });
  const transport: R2RestTransport = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), path = url.pathname.replace(`/client/v4/accounts/${config.account_id}`, "");
    calls.push({ method: request.method, path: `${path}${url.search}` });
    const lost = (phase: NonNullable<typeof faults.lost>) => { if (faults.lost === phase) throw new Error("private-key unconfirmed request"); };
    if (url.hostname !== "api.cloudflare.com") {
      const key = administratorKey(keyRoot ?? root);
      const showId = request.headers.get("X-Castloop-Show-Id");
      if (showId) {
        const node = nodes.get(showId);
        if (!node) return new Response(null, { status: 404 });
        const response = await node.service.fetch(request);
        if (path.endsWith("/resume") || path.endsWith("/pause")) lost("control");
        if (path.endsWith("/jobs") && request.method === "POST" && response.status === 202) {
          node.fixture.clearAlarm();
          await new SqlitePublicationAlarm(node.service.queue, createSqlitePublicationExecutor(node.service.content, objects.bucket, config,
            { purge: async ({ showId }) => { purges.push(showId); } }), () => {}).alarm();
          await faults.afterPublish?.();
        }
        return response;
      }
      if (path.startsWith("/admin/sqlite-service/")) {
        const response = await createSqliteControlHttp(control, key)(request);
        if (path.endsWith("/prepare") && response.status === 202) {
          if (faults.failPurge) objects.hooks.beforeGet = async () => { throw new Error("probe unavailable"); };
          queue.clearAlarm(); await runtime.alarm(); lost("setup");
        }
        if (path.endsWith("/register-show")) lost("register");
        if (path.endsWith("/resume") || path.endsWith("/pause")) lost("control");
        if (path.endsWith("/update-prepare")) lost("update-prepare");
        if (path.endsWith("/update-activate") && response.ok) {
          if (faults.failPurge) objects.hooks.beforeGet = async () => { throw new Error("probe unavailable"); };
          if (!faults.deferUpdateProbe) { queue.clearAlarm(); await runtime.alarm(); await control.progress(); }
          lost("activation");
        }
        return response;
      }
      return new Response(null, { status: 400 });
    }
    if (request.headers.get("Authorization") !== "Bearer private-token") return new Response(null, { status: 403 });
    if (path === `/r2/buckets/${config.bucket_name}` && request.method === "GET") return faults.existing === "empty" ? json(null) :
      bucketCreated || faults.existing === "bucket" ? json({ name: config.bucket_name }) : new Response(null, { status: 404 });
    if (path === "/r2/buckets" && request.method === "POST") { bucketCreated = true; lost("bucket"); return json({ name: config.bucket_name }); }
    if (path.includes("/objects/")) {
      const key = path.split("/objects/")[1];
      if (request.method === "PUT") {
        const object = (await objects.bucket.put(key, new Uint8Array(await request.arrayBuffer())))!;
        if (key === "system/service.toml") lost("config");
        return json({ key, size: object.size, etag: object.etag, version: object.version });
      }
      const object = await objects.bucket.get(key);
      return object ? new Response(object.body, { headers: { ETag: `"${object.etag}"` } }) : new Response(null, { status: 404 });
    }
    if (path === "/workers/subdomain") return json({ subdomain: "example" });
    if (path === "/workers/workers" && request.method === "POST") { workerCreated = true; lost("worker"); return json({ name: config.worker_name }); }
    if (path.endsWith("/settings")) {
      if (metadata && faults.failFirstInspection) { faults.failFirstInspection = false; return json({ invalid: true }); }
      return metadata ? json(settings()) : faults.existing === "worker" ? json({ unknown: true }) : new Response(null, { status: 404 });
    }
    if (path === `/workers/scripts/${config.worker_name}` && request.method === "PUT") {
      if (!workerCreated) throw new Error("Worker must be created first");
      const updating = metadata !== null;
      const form = await request.formData(); metadata = JSON.parse(String(form.get("metadata")));
      etag = sha256HexSync(await (form.get("index.js") as File).text());
      if (updating) {
        previousVersion = actual.worker_version_id; actual = { ...actual, worker_version_id: crypto.randomUUID() }; deploymentId = crypto.randomUUID(); runtime = boot();
        faults.afterDeploy?.();
      }
      lost("deploy"); return json({ etag });
    }
    if (path.endsWith("/deployments")) return json(deployment());
    if (path.includes("/versions/")) {
      const current = settings();
      return json({ id: actual.worker_version_id, resources: { bindings: current.bindings, script: { etag },
        script_runtime: { ...(faults.missingVersionExports ? {} : { exports: metadata!.exports }), compatibility_date: current.compatibility_date,
          compatibility_flags: current.compatibility_flags, cache_options: current.cache_options } } });
    }
    if (path.endsWith("/subdomain")) {
      if (request.method === "POST") { access = true; lost("access"); }
      return json({ enabled: access, previews_enabled: false });
    }
    if (path === "/workers/durable_objects/namespaces") return json([{ id: namespaceId, script: faults.namespace ? "other-worker" : config.worker_name, class: "SqlitePublicationService", use_sqlite: true }]);
    throw new Error(`Unhandled fixture route ${request.method} ${path}`);
  };
  const first = () => nodes.values().next().value;
  return { ...queue, ...objects, root, config, nodes, showCalls, controlStorage: queue.storage, get control() { return control; }, get content() { return first()?.service.content ?? content; },
    get database() { return first()?.fixture.database ?? queue.database; },
    get storage() { return first()?.fixture.storage ?? queue.storage; },
    get runtime() { return runtime; }, get queue() { return first()?.service.queue ?? nativeQueue; }, purges, calls, faults, metadata: () => metadata,
    options: { accountId: config.account_id, apiToken: "private-token", transport }, transport,
    close() { for (const node of nodes.values()) node.fixture.close(); queue.close(); rmSync(root, { recursive: true, force: true }); } };
}
