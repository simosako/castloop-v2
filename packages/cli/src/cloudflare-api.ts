import { migrationBootstrapRequestSchema, migrationCandidateUploadSchema, serviceConfigSchema, workerDeploymentsSnapshotSchema,
  workerSubdomainSnapshotSchema } from "@castloop/shared";
import type { MigrationBootstrapRequest, MigrationBridgePreparation, MigrationBridgeUpload, MigrationCandidateUpload,
  M6WorkerDeploymentEvidence, ServiceConfig } from "@castloop/shared";
import { buildMigrationCandidateUpload, inspectM6WorkerDeployment, requireMigrationBridgeSettings, requireMigrationBridgeVersion } from "./m6-worker-deployment";
import { migrationPayloadHash } from "./migration-deployment";
import { prepareMigrationBridgeDeployment } from "./migration-bridge-deployment";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

type ApiResult<T> = { success: boolean; result: T; errors?: Array<{ code: number; message: string }> };
type QueueRecord = { queue_id: string; queue_name: string };
type ConsumerRecord = { consumer_id: string; script_name?: string; script?: string;
  dead_letter_queue?: string; settings?: { batch_size?: number; max_concurrency?: number; max_retries?: number } };
type WorkerSettings = {
  bindings?: Array<{ name: string; type: string }>;
  exports?: Record<string, unknown>;
  cache_options?: { enabled: boolean; cross_version_cache?: boolean };
  compatibility_flags?: string[];
  logpush?: boolean;
  observability?: object;
  placement?: object;
  tags?: string[];
  tail_consumers?: object[];
};
type WorkerDomain = { id: string; hostname: string; service: string; zone_id: string; zone_name: string };
type ZoneRecord = { id: string; name: string; status: string; type: string;
  account?: { id?: string }; paused?: boolean };
type DnsRecord = { name: string; type: string };
type PaginatedResult<T> = ApiResult<T[]> & { result_info?: { total_pages?: number } };

export function normalizeHostname(value: string): string {
  const hostname = value.toLowerCase();
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2 || labels.some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1)!)) {
    throw new Error("Expected a DNS hostname without a URL scheme, path, or port");
  }
  return hostname;
}

export class CloudflareApi {
  private readonly base: string;
  private readonly accountId: string;
  private readonly token: string;

  constructor(config: ServiceConfig) {
    if (process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id || !process.env.CLOUDFLARE_API_TOKEN) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this service");
    }
    this.base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}`;
    this.accountId = config.account_id;
    this.token = process.env.CLOUDFLARE_API_TOKEN;
  }

  private async request(method: string, path: string, body?: BodyInit, contentType?: string,
    timeout = 30000, global = false): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${global ? "https://api.cloudflare.com/client/v4" : this.base}${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`,
          ...(contentType ? { "Content-Type": contentType } : {}) },
        ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(timeout), redirect: "error",
      });
    } catch (error) {
      throw new Error(`Cloudflare ${method} ${path} could not connect: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const data: ApiResult<unknown> = JSON.parse(text);
        if (data.errors?.length) message += ` (${data.errors.map((item) => `${item.code}: ${item.message}`).join(", ")})`;
      } catch { /* An HTTP status is sufficient when the response is not JSON. */ }
      throw new Error(`Cloudflare ${method} ${path} failed: ${message}`);
    }
    return response;
  }

  private async json<T>(method: string, path: string, value?: object, global = false): Promise<T> {
    const response = await this.request(method, path,
      value ? JSON.stringify(value) : undefined, value ? "application/json" : undefined, 30000, global);
    const data: ApiResult<T> = await response.json();
    if (!data.success) throw new Error(`Cloudflare ${method} ${path} did not succeed`);
    return data.result;
  }

  async createBucket(name: string): Promise<void> {
    await this.json("POST", "/r2/buckets", { name });
  }

  async createQueue(name: string): Promise<void> {
    await this.json("POST", "/queues", { queue_name: name });
  }

  private async page<T>(path: string, global = false): Promise<PaginatedResult<T>> {
    const response = await this.request("GET", path, undefined, undefined, 30000, global);
    const data: PaginatedResult<T> = await response.json();
    if (!data.success || !Array.isArray(data.result)) {
      throw new Error(`Cloudflare GET ${path} did not return a list`);
    }
    return data;
  }

  async zoneForHostname(hostname: string): Promise<{ id: string; name: string }> {
    const zones: ZoneRecord[] = [];
    for (let page = 1; ; page += 1) {
      const path = `/zones?account.id=${encodeURIComponent(this.accountId)}&page=${page}&per_page=50`;
      const data = await this.page<ZoneRecord>(path, true);
      zones.push(...data.result);
      if (page >= (data.result_info?.total_pages ?? 1)) break;
    }
    const zone = zones.filter((item) => hostname === item.name || hostname.endsWith(`.${item.name}`))
      .sort((left, right) => right.name.length - left.name.length)[0];
    if (!zone) throw new Error(`No Cloudflare zone in this account contains ${hostname}`);
    if (zone.account?.id !== this.accountId || zone.status !== "active" || zone.type !== "full" || zone.paused) {
      throw new Error(`Zone ${zone.name} must be active with Cloudflare authoritative DNS`);
    }
    return { id: zone.id, name: zone.name };
  }

  async workerDomains(filter: "hostname" | "service", value: string): Promise<WorkerDomain[]> {
    const path = `/workers/domains?${filter}=${encodeURIComponent(value)}`;
    const data = await this.page<WorkerDomain>(path);
    if ((data.result_info?.total_pages ?? 1) > 1) {
      throw new Error("Worker Domains response is incomplete; refusing to change a domain");
    }
    return data.result;
  }

  async ensureWorkerDomain(hostname: string, service: string): Promise<WorkerDomain> {
    hostname = normalizeHostname(hostname);
    const [existing, forService] = await Promise.all([
      this.workerDomains("hostname", hostname), this.workerDomains("service", service),
    ]);
    if (existing.some((domain) => domain.hostname !== hostname) ||
      forService.some((domain) => domain.service !== service)) {
      throw new Error("Worker Domain lookup returned unexpected records");
    }
    if (forService.some((domain) => domain.hostname !== hostname) || existing.some((domain) => domain.service !== service)) {
      throw new Error("The hostname or Worker already has a different Custom Domain");
    }
    const zone = await this.zoneForHostname(hostname);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].zone_id !== zone.id) {
        throw new Error("The Custom Domain is attached to a different zone");
      }
      return existing[0];
    }
    const path = `/zones/${encodeURIComponent(zone.id)}/dns_records?name.exact=${encodeURIComponent(hostname)}&per_page=100`;
    const records = await this.page<DnsRecord>(path, true);
    if ((records.result_info?.total_pages ?? 1) > 1 || records.result.some((record) =>
      record.name === hostname && ["A", "AAAA", "CNAME", "NS"].includes(record.type))) {
      throw new Error(`DNS records for ${hostname} conflict with a new Custom Domain`);
    }
    return this.json<WorkerDomain>("PUT", "/workers/domains", {
      hostname, service, zone_id: zone.id,
    });
  }

  async removeWorkerDomain(hostname: string, service: string): Promise<void> {
    hostname = normalizeHostname(hostname);
    const domains = await this.workerDomains("hostname", hostname);
    if (!domains.length) return;
    if (domains.length !== 1 || domains[0].hostname !== hostname || domains[0].service !== service) {
      throw new Error(`Custom Domain ${hostname} is not owned by this Worker`);
    }
    await this.json("DELETE", `/workers/domains/${encodeURIComponent(domains[0].id)}`);
  }

  async queueId(name: string): Promise<string> {
    for (let page = 1; ; page += 1) {
      const path = `/queues?page=${page}`;
      const response = await this.request("GET", path);
      const data: ApiResult<QueueRecord[]> & { result_info?: { total_pages?: number } } = await response.json();
      if (!data.success) throw new Error(`Cloudflare GET ${path} did not succeed`);
      const id = data.result.find((queue) => queue.queue_name === name)?.queue_id;
      if (id) return id;
      if (page >= (data.result_info?.total_pages ?? 1)) break;
    }
    throw new Error(`Queue ${name} was not found in this Cloudflare account`);
  }

  private async existingWorker(name: string): Promise<WorkerSettings | null> {
    const path = `/workers/scripts/${encodeURIComponent(name)}/settings`;
    const response = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare GET ${path} failed: HTTP ${response.status}`);
    const data: ApiResult<WorkerSettings> = await response.json();
    if (!data.success) throw new Error(`Cloudflare GET ${path} did not succeed`);
    return data.result;
  }

  async deployWorker(config: ServiceConfig, source: string, adminKey: string,
    compatibilityDate: string): Promise<void> {
    const previous = await this.existingWorker(config.worker_name);
    if (previous?.exports?.CachedPublicAssets !== undefined ||
      previous?.bindings?.some((binding) => binding.name === "CASTLOOP_VERSION_METADATA")) {
      throw new Error("Legacy deploy cannot replace an M6 Worker; use a verified migration-aware deployment path");
    }
    const managed = new Set(["CASTLOOP_BUCKET", "CASTLOOP_QUEUE", "CASTLOOP_DLQ_NAME", "CASTLOOP_ADMIN_KEY"]);
    const preserved = previous?.bindings?.filter((binding) => !managed.has(binding.name))
      .map((binding) => ({ name: binding.name, type: "inherit" })) ?? [];
    const adminSecret = previous?.bindings?.some((binding) => binding.name === "CASTLOOP_ADMIN_KEY")
      ? { name: "CASTLOOP_ADMIN_KEY", type: "inherit" }
      : { name: "CASTLOOP_ADMIN_KEY", type: "secret_text", text: adminKey };
    const metadata = {
      main_module: "index.js", compatibility_date: compatibilityDate,
      cache_options: { enabled: true,
        ...(previous?.cache_options?.cross_version_cache !== undefined
          ? { cross_version_cache: previous.cache_options.cross_version_cache } : {}) },
      observability: previous?.observability ?? { enabled: true, traces: { enabled: true } },
      ...(previous?.compatibility_flags?.length ? { compatibility_flags: previous.compatibility_flags } : {}),
      ...(previous?.tags?.length ? { tags: previous.tags } : {}),
      ...(previous?.tail_consumers?.length ? { tail_consumers: previous.tail_consumers } : {}),
      ...(previous?.placement ? { placement: previous.placement } : {}),
      ...(previous?.logpush ? { logpush: previous.logpush } : {}),
      bindings: [
        { name: "CASTLOOP_BUCKET", type: "r2_bucket", bucket_name: config.bucket_name },
        { name: "CASTLOOP_QUEUE", type: "queue", queue_name: config.queue_name },
        { name: "CASTLOOP_DLQ_NAME", type: "plain_text", text: config.dlq_name },
        adminSecret, ...preserved,
      ],
    };
    const upload = new FormData();
    upload.set("metadata", JSON.stringify(metadata));
    upload.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    await this.jsonUpload(`/workers/scripts/${encodeURIComponent(config.worker_name)}?bindings_inherit=strict`, upload);
    await this.json("POST", `/workers/scripts/${encodeURIComponent(config.worker_name)}/subdomain`,
      { enabled: true, previews_enabled: false });
  }

  async inspectM6WorkerDeployment(config: ServiceConfig, expectedVersionId: string): Promise<M6WorkerDeploymentEvidence> {
    if (config.account_id !== this.accountId) throw new Error("Worker inspection targets another Cloudflare account");
    const path = `/workers/scripts/${encodeURIComponent(config.worker_name)}`;
    return inspectM6WorkerDeployment(config, expectedVersionId, {
      deployments: () => this.json<unknown>("GET", `${path}/deployments`),
      settings: () => this.json<unknown>("GET", `${path}/settings`),
      version: (versionId) => this.json<unknown>("GET", `${path}/versions/${encodeURIComponent(versionId)}`),
      subdomain: () => this.json<unknown>("GET", `${path}/subdomain`),
    });
  }

  private migrationWorkerPath(input: ServiceConfig): string {
    const config = serviceConfigSchema.parse(input);
    const url = new URL(config.public_base_url);
    if (config.account_id !== this.accountId || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !url.hostname.startsWith(`${config.worker_name}.`) || !url.hostname.endsWith(".workers.dev")) {
      throw new Error("Migration REST deploy requires this account's existing workers.dev service; custom-domain/route migration is not released");
    }
    return `/workers/scripts/${encodeURIComponent(config.worker_name)}`;
  }

  private async singleMigrationDeployment(path: string, expectedVersionId: string) {
    migrationBootstrapRequestSchema.shape.bridge_worker_version_id.parse(expectedVersionId);
    const value = workerDeploymentsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/deployments`)).deployments[0]!;
    if (value.versions.length !== 1 || value.versions[0]!.version_id !== expectedVersionId || value.versions[0]!.percentage !== 100) {
      throw new Error("Migration requires the expected single Worker version serving 100% before any write");
    }
    return value;
  }

  async prepareMigrationBridge(config: ServiceConfig, legacyVersionId: string, bridgeId: string, source: string):
    Promise<{ request: MigrationBridgePreparation; metadata: MigrationBridgeUpload }> {
    const path = this.migrationWorkerPath(config);
    return prepareMigrationBridgeDeployment(config, legacyVersionId, bridgeId, source, {
      deployments: () => this.json<unknown>("GET", `${path}/deployments`),
      settings: () => this.json<unknown>("GET", `${path}/settings`),
      version: (id) => this.json<unknown>("GET", `${path}/versions/${encodeURIComponent(id)}`),
      subdomain: () => this.json<unknown>("GET", `${path}/subdomain`),
      domains: () => this.workerDomains("service", config.worker_name),
    });
  }

  async migrationCandidateUploadMetadata(config: ServiceConfig, bootstrapId: string, bridgeVersionId: string): Promise<MigrationCandidateUpload> {
    const path = this.migrationWorkerPath(config);
    const before = await this.singleMigrationDeployment(path, bridgeVersionId);
    const previous = requireMigrationBridgeSettings(await this.json<unknown>("GET", `${path}/settings`), config);
    requireMigrationBridgeVersion(await this.json<unknown>("GET", `${path}/versions/${encodeURIComponent(bridgeVersionId)}`), config, bridgeVersionId);
    const domains = await this.workerDomains("service", config.worker_name);
    if (domains.length) throw new Error("Migration deploy cannot alter a Worker with attached Custom Domains");
    const previews = workerSubdomainSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/subdomain`));
    if (!previews.enabled || previews.previews_enabled) throw new Error("Migration bridge requires workers.dev enabled and old previews disabled");
    const metadata = buildMigrationCandidateUpload(config, previous, bootstrapId, bridgeVersionId);
    const latestMetadata = buildMigrationCandidateUpload(config, await this.json<unknown>("GET", `${path}/settings`), bootstrapId, bridgeVersionId);
    const current = await this.singleMigrationDeployment(path, bridgeVersionId);
    if (JSON.stringify(current) !== JSON.stringify(before) || migrationPayloadHash(latestMetadata) !== migrationPayloadHash(metadata)) {
      throw new Error("Migration bridge deployment/settings changed during metadata preparation");
    }
    return metadata;
  }

  async uploadMigrationCandidate(config: ServiceConfig, input: MigrationBootstrapRequest, source: string, metadataInput: object): Promise<void> {
    const request = migrationBootstrapRequestSchema.parse(input);
    const metadata = migrationCandidateUploadSchema.parse(metadataInput);
    if (request.service_id !== config.service_id || metadata.annotations["workers/tag"] !== request.bootstrap_id ||
      migrationPayloadHash(source) !== request.worker_source_sha256 || migrationPayloadHash(metadataInput) !== request.worker_metadata_sha256) {
      throw new Error("Candidate upload differs from its frozen service/bootstrap/source/metadata request");
    }
    const path = this.migrationWorkerPath(config);
    const expected = await this.migrationCandidateUploadMetadata(config, request.bootstrap_id, request.bridge_worker_version_id);
    if (migrationPayloadHash(expected) !== request.worker_metadata_sha256) throw new Error("Migration bridge settings changed after upload metadata was frozen");
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadataInput));
    form.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    await this.jsonUpload(`${path}?bindings_inherit=strict`, form);
  }

  async disableMigrationWorkerPreviews(config: ServiceConfig, workerVersionId: string): Promise<void> {
    const path = this.migrationWorkerPath(config);
    await this.singleMigrationDeployment(path, workerVersionId);
    const result = workerSubdomainSnapshotSchema.parse(await this.json<unknown>("POST", `${path}/subdomain`, { enabled: true, previews_enabled: false }));
    if (!result.enabled || result.previews_enabled) throw new Error("Migration preview setting was not accepted");
  }

  private async jsonUpload(path: string, body: FormData): Promise<void> {
    const response = await this.request("PUT", path, body, undefined, 120000);
    const data: ApiResult<unknown> = await response.json();
    if (!data.success) throw new Error(`Cloudflare PUT ${path} did not succeed`);
  }

  async ensureConsumer(queueId: string, config: ServiceConfig, dlq: boolean): Promise<void> {
    const path = `/queues/${encodeURIComponent(queueId)}/consumers`;
    const existing = await this.json<ConsumerRecord[]>("GET", path);
    if (existing.length) {
      if (existing.length !== 1 || (existing[0].script_name ?? existing[0].script) !== config.worker_name ||
        existing[0].settings?.batch_size !== 1 || existing[0].settings?.max_concurrency !== 1 ||
        (!dlq && (existing[0].dead_letter_queue !== config.dlq_name ||
          existing[0].settings?.max_retries !== 2))) {
        throw new Error(`Queue ${dlq ? config.dlq_name : config.queue_name} has an unexpected consumer`);
      }
      return;
    }
    await this.json("POST", path, { script_name: config.worker_name, type: "worker",
      ...(dlq ? {} : { dead_letter_queue: config.dlq_name, settings: { batch_size: 1,
        max_concurrency: 1, max_retries: 2 } }),
      ...(dlq ? { settings: { batch_size: 1, max_concurrency: 1 } } : {}),
    });
  }

  async createNotification(config: ServiceConfig, queueId: string): Promise<void> {
    await this.json("PUT", `/event_notifications/r2/${encodeURIComponent(config.bucket_name)}` +
      `/configuration/queues/${encodeURIComponent(queueId)}`, {
      rules: [{ actions: ["PutObject", "CopyObject", "CompleteMultipartUpload"],
        prefix: "staging/", suffix: "commit.json" }],
    });
  }

  async putObject(bucket: string, key: string, file: string, contentType: string,
    checksum?: string): Promise<void> {
    const length = statSync(file).size;
    const path = `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key}`;
    const response = await this.request("PUT", path, Bun.file(file), contentType, 300000);
    const data: ApiResult<{ size: number | string }> = await response.json();
    if (!data.success || Number(data.result?.size) !== length) {
      throw new Error(`R2 upload size mismatch for ${key}`);
    }
    if (checksum) await this.verifyObject(bucket, key, length, checksum);
  }

  private async verifyObject(bucket: string, key: string, length: number, checksum: string): Promise<void> {
    const path = `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key}`;
    const response = await this.request("GET", path, undefined, undefined, 300000);
    if (!response.body) throw new Error(`R2 download for ${key} was empty`);
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      hash.update(chunk);
    }
    if (received !== length || hash.digest("hex") !== checksum) {
      throw new Error(`R2 upload verification failed for ${key}`);
    }
  }
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
