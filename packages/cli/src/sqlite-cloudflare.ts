import { z } from "zod";
import { sha256Hex, stringifyToml } from "@castloop/shared";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { buildSqliteWorkerMetadata, SQLITE_WORKER_COMPATIBILITY_DATE } from "../../shared/src/sqlite-worker-deployment";
import { putVerifiedR2Object, requireR2RestOptions } from "./verified-r2-put";
import type { R2RestOptions } from "./verified-r2-put";
import { collectStreamBytes } from "./bounded-http-read";

const uuid = z.uuid(), hash = z.string().min(1).max(256);
export const sqliteScriptUploadReceiptSchema = z.object({ script_etag: hash }).strict();
export type SqliteScriptUploadReceipt = z.infer<typeof sqliteScriptUploadReceiptSchema>;
const evidenceSchema = z.object({ worker_version_id: uuid, deployment_id: uuid, namespace_id: z.string().regex(/^[a-f0-9]{32}$/), script_etag: hash }).strict();
export type SqliteDeploymentEvidence = z.infer<typeof evidenceSchema>;
const record = z.record(z.string(), z.unknown());
const settingsSchema = z.object({ bindings: z.array(record), exports: record.optional(), compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()), cache_options: z.object({ enabled: z.boolean(), cross_version_cache: z.boolean() }),
  observability: z.object({ enabled: z.boolean(), logs: z.object({ enabled: z.boolean() }), traces: z.object({ enabled: z.boolean() }) }) });
const deploymentSchema = z.object({ deployments: z.array(z.object({ id: uuid, versions: z.array(z.object({ version_id: uuid, percentage: z.number() })) })) });

export class SqliteCloudflareApi {
  readonly config: SqliteServiceConfig;
  private readonly base: string;
  constructor(config: SqliteServiceConfig, private readonly options: R2RestOptions) {
    this.config = sqliteServiceConfigSchema.parse(config); requireR2RestOptions(this.config.account_id, options);
    this.base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.config.account_id)}`;
  }
  private async call(method: string, path: string, body?: BodyInit, contentType?: string, absent = false): Promise<unknown> {
    let response: Response;
    try { response = await (this.options.transport ?? fetch)(`${this.base}${path}`, { method, body, redirect: "error",
      signal: AbortSignal.timeout(method === "PUT" ? 120000 : 30000), headers: { Authorization: `Bearer ${this.options.apiToken}`,
        ...(contentType ? { "Content-Type": contentType } : {}) } }); }
    catch { throw new Error("Cloudflare request outcome is unknown; preserve the operation journal without retry"); }
    if (response.status === 404 && absent) { await response.body?.cancel(); return null; }
    if (![200, 201].includes(response.status) || !response.body || response.headers.has("Content-Range")) {
      await response.body?.cancel(); throw new Error(`Cloudflare request was not verified (HTTP ${response.status})`);
    }
    try {
      const bytes = await collectStreamBytes(response.body, 1_000_000, true);
      const parsed = z.object({ success: z.literal(true), result: z.unknown() }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
      if (absent && parsed.result === null) throw new Error("Only an explicit 404 proves resource absence");
      return parsed.result;
    } catch { throw new Error("Cloudflare response was not verified; do not replay a mutation"); }
  }
  private json(method: string, path: string, value?: object): Promise<unknown> {
    return this.call(method, path, value ? JSON.stringify(value) : undefined, value ? "application/json" : undefined);
  }
  private path(): string { return `/workers/scripts/${encodeURIComponent(this.config.worker_name)}`; }
  async preflight(): Promise<void> {
    if (this.config.public_base_url !== this.config.workers_dev_base_url) throw new Error("Fresh SQLite initialization requires its workers.dev public origin");
    const bucket = await this.call("GET", `/r2/buckets/${encodeURIComponent(this.config.bucket_name)}`, undefined, undefined, true);
    const worker = await this.call("GET", `${this.path()}/settings`, undefined, undefined, true);
    if (bucket !== null || worker !== null) throw new Error("Fresh SQLite initialization cannot adopt an existing or unknown bucket/Worker");
    const subdomain = z.object({ subdomain: z.string() }).parse(await this.json("GET", "/workers/subdomain"));
    if (new URL(this.config.workers_dev_base_url).hostname !== `${this.config.worker_name}.${subdomain.subdomain}.workers.dev`) throw new Error("Configured workers.dev subdomain differs from this account");
  }
  async createBucket(): Promise<void> {
    const bucket = z.object({ name: z.string() }).parse(await this.json("POST", "/r2/buckets", { name: this.config.bucket_name }));
    if (bucket.name !== this.config.bucket_name) throw new Error("Created R2 bucket differs");
  }
  async uploadConfig(): Promise<void> {
    const bytes = new TextEncoder().encode(stringifyToml(this.config));
    const digest = await sha256Hex(bytes);
    let consumed = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes); controller.close(); consumed = true; } });
    await putVerifiedR2Object(this.config, { key: "system/service.toml", length: bytes.length, sha256: digest, contentType: "application/toml" }, body,
      () => { if (!consumed) throw new Error("Service config upload was not consumed"); }, this.options);
  }
  async createWorker(): Promise<void> {
    const worker = z.object({ name: z.string() }).parse(await this.json("POST", "/workers/workers", { name: this.config.worker_name }));
    if (worker.name !== this.config.worker_name) throw new Error("Created Worker differs");
  }
  async deploy(source: string, adminKey: string): Promise<{ script_etag: string; worker_version_id: string; deployment_id: string }> {
    const receipt = await this.uploadWorker(source, adminKey);
    const deployment = this.singleDeployment(await this.json("GET", `${this.path()}/deployments`));
    return { ...receipt, worker_version_id: deployment.versions[0].version_id, deployment_id: deployment.id };
  }
  async uploadWorker(source: string, adminKey: string): Promise<SqliteScriptUploadReceipt> {
    if (!source) throw new Error("SQLite Worker source is missing");
    const form = new FormData(); form.set("metadata", JSON.stringify(buildSqliteWorkerMetadata(this.config, adminKey)));
    form.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    const receipt = z.object({ etag: hash }).parse(await this.call("PUT", `${this.path()}?bindings_inherit=strict`, form));
    return { script_etag: receipt.etag };
  }
  async deploymentReceipt(input: SqliteScriptUploadReceipt): Promise<{ script_etag: string; worker_version_id: string; deployment_id: string }> {
    const receipt = sqliteScriptUploadReceiptSchema.parse(input);
    const deployment = this.singleDeployment(await this.json("GET", `${this.path()}/deployments`));
    const versionId = deployment.versions[0].version_id;
    const version = z.object({ id: uuid, resources: z.object({ script: z.object({ etag: hash }) }) }).parse(
      await this.json("GET", `${this.path()}/versions/${encodeURIComponent(versionId)}`));
    if (version.id !== versionId || version.resources.script.etag !== receipt.script_etag) throw new Error("SQLite deployment does not match its acknowledged script upload");
    return { ...receipt, worker_version_id: versionId, deployment_id: deployment.id };
  }
  private singleDeployment(input: unknown, versionId?: string) {
    const deployment = deploymentSchema.parse(input).deployments[0];
    if (!deployment || deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100 ||
      versionId !== undefined && deployment.versions[0].version_id !== versionId) throw new Error("SQLite deployment is not the expected single version at 100%");
    return deployment;
  }
  async enableAccess(versionId: string): Promise<void> {
    this.singleDeployment(await this.json("GET", `${this.path()}/deployments`), versionId);
    const value = z.object({ enabled: z.literal(true), previews_enabled: z.literal(false) }).parse(
      await this.json("POST", `${this.path()}/subdomain`, { enabled: true, previews_enabled: false }));
    if (!value.enabled) throw new Error("SQLite workers.dev access was not verified");
  }
  private checkSettings(input: unknown, versionExports: Record<string, unknown>): { namespaceId: string; fingerprint: string } {
    const settings = settingsSchema.parse(input), expected = buildSqliteWorkerMetadata(this.config, "comparison-only");
    const exports = settings.exports ?? versionExports;
    if (settings.compatibility_date !== SQLITE_WORKER_COMPATIBILITY_DATE ||
      JSON.stringify(settings.compatibility_flags) !== JSON.stringify(expected.compatibility_flags) ||
      JSON.stringify(settings.cache_options) !== JSON.stringify(expected.cache_options) ||
      !settings.observability.enabled || !settings.observability.logs.enabled || !settings.observability.traces.enabled ||
      JSON.stringify(Object.keys(exports).sort()) !== JSON.stringify(Object.keys(expected.exports).sort())) throw new Error("SQLite runtime settings differ");
    for (const [name, value] of Object.entries(expected.exports)) {
      const actual = record.parse(exports[name]);
      if (actual.type !== value.type || actual.container !== undefined || actual.state !== undefined && actual.state !== "created" ||
        ("storage" in value ? actual.storage !== value.storage : record.parse(actual.cache).enabled !== value.cache.enabled)) throw new Error("SQLite runtime exports differ");
    }
    if (settings.bindings.length !== expected.bindings.length || new Set(settings.bindings.map((binding) => binding.name)).size !== expected.bindings.length) throw new Error("SQLite bindings differ");
    for (const binding of expected.bindings) {
      const actual = settings.bindings.find((item) => item.name === binding.name);
      if (!actual || actual.type !== binding.type || "bucket_name" in binding && actual.bucket_name !== binding.bucket_name ||
        binding.type === "plain_text" && actual.text !== binding.text || binding.type === "durable_object_namespace" &&
        (actual.class_name !== undefined && actual.class_name !== binding.class_name || actual.script_name !== undefined && actual.script_name !== this.config.worker_name)) throw new Error("SQLite binding target differs");
    }
    const namespaceId = z.string().regex(/^[a-f0-9]{32}$/).parse(settings.bindings.find((binding) => binding.name === "CASTLOOP_SQLITE")!.namespace_id);
    return { namespaceId, fingerprint: JSON.stringify({ exports, bindings: settings.bindings.map(({ text, ...binding }) => binding),
      compatibility_date: settings.compatibility_date, cache_options: settings.cache_options }) };
  }
  async inspect(expected: { worker_version_id: string; deployment_id: string; script_etag: string }): Promise<SqliteDeploymentEvidence> {
    const first = this.singleDeployment(await this.json("GET", `${this.path()}/deployments`), expected.worker_version_id);
    if (first.id !== expected.deployment_id) throw new Error("SQLite deployment receipt differs");
    const settingsInput = settingsSchema.parse(await this.json("GET", `${this.path()}/settings`));
    const version = z.object({ id: uuid, resources: z.object({ bindings: z.array(record), script: z.object({ etag: hash }),
      script_runtime: settingsSchema.pick({ compatibility_date: true, compatibility_flags: true }).extend({ exports: record,
        cache_options: settingsSchema.shape.cache_options.optional() }) }) }).parse(await this.json("GET", `${this.path()}/versions/${encodeURIComponent(expected.worker_version_id)}`));
    const settings = this.checkSettings(settingsInput, version.resources.script_runtime.exports);
    if (version.id !== expected.worker_version_id || version.resources.script.etag !== expected.script_etag ||
      this.checkSettings({ ...settingsInput, ...version.resources.script_runtime, bindings: version.resources.bindings }, version.resources.script_runtime.exports).namespaceId !== settings.namespaceId) throw new Error("SQLite uploaded version differs");
    let namespaceVerified = false;
    for (let page = 1; page <= 100; page++) {
      const namespaces = z.array(record).parse(
        await this.json("GET", `/workers/durable_objects/namespaces?page=${page}&per_page=100`));
      const found = namespaces.find((item) => item.id === settings.namespaceId);
      if (found) { namespaceVerified = found.script === this.config.worker_name && found.class === "SqlitePublicationService" && found.use_sqlite === true; break; }
      if (namespaces.length < 100) break;
    }
    if (!namespaceVerified) throw new Error("SQLite namespace does not belong to the expected Worker class");
    z.object({ enabled: z.literal(true), previews_enabled: z.literal(false) }).parse(await this.json("GET", `${this.path()}/subdomain`));
    const after = this.checkSettings(await this.json("GET", `${this.path()}/settings`), version.resources.script_runtime.exports);
    const last = this.singleDeployment(await this.json("GET", `${this.path()}/deployments`), expected.worker_version_id);
    if (after.fingerprint !== settings.fingerprint || JSON.stringify(last) !== JSON.stringify(first)) throw new Error("SQLite runtime changed during inspection");
    return evidenceSchema.parse({ ...expected, namespace_id: settings.namespaceId });
  }
  async current(): Promise<SqliteDeploymentEvidence> {
    const deployment = this.singleDeployment(await this.json("GET", `${this.path()}/deployments`));
    const versionId = deployment.versions[0].version_id;
    const version = z.object({ id: uuid, resources: z.object({ script: z.object({ etag: hash }) }) }).parse(await this.json("GET", `${this.path()}/versions/${encodeURIComponent(versionId)}`));
    if (version.id !== versionId) throw new Error("SQLite current version differs");
    return this.inspect({ worker_version_id: versionId, deployment_id: deployment.id, script_etag: version.resources.script.etag });
  }
}
