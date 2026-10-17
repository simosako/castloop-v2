import { buildM6WorkerUploadMetadata, collectM6DeploymentSnapshot, inspectM6WorkerDeployment, M6_FRESH_WORKER_COMPATIBILITY_DATE,
  M6_WORKER_COMPATIBILITY_DATE, m6RuntimeTargetSchema, m6ServiceConfigHash, m6ServiceUpdateRequestSchema, normalizeHostname,
  parseManagementIntent, publicationQueueIdSchema, serviceConfigSchema, serviceManagementBaseUrl, stringifyToml, workerDeploymentsSnapshotSchema,
  workerScriptUploadReceiptSchema, workerSettingsSnapshotSchema, workerSubdomainSnapshotSchema, workerVersionSnapshotSchema,
  workerVersionUploadReceiptSchema, workerVersionsSnapshotSchema } from "@castloop/shared";
import type { M6DeploymentReads, M6DeploymentSnapshot, M6RuntimeTarget, M6ServiceUpdateRequest, M6WorkerDeploymentEvidence,
  M6WorkerUploadMetadata, ManagementIntent, ServiceConfig, WorkerVersionUploadReceipt } from "@castloop/shared";
import type { M6UpdateDeployReceipts } from "./m6-service-update";
import { workerPayloadHash } from "./worker-upload-hash";

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
export type WorkerDomain = { id: string; hostname: string; service: string; zone_id: string; zone_name: string };
type ZoneRecord = { id: string; name: string; status: string; type: string;
  account?: { id?: string }; paused?: boolean };
type DnsRecord = { name: string; type: string };
type PaginatedResult<T> = ApiResult<T[]> & { result_info?: { total_pages?: number } };

export { normalizeHostname } from "@castloop/shared";

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
    const data: unknown = await response.json();
    if (data === null || typeof data !== "object" || !("success" in data) || data.success !== true) {
      throw new Error(`Cloudflare ${method} ${path} did not succeed`);
    }
    return (data as ApiResult<T>).result;
  }

  async createBucket(name: string): Promise<void> {
    await this.json("POST", "/r2/buckets", { name });
  }

  async createQueue(name: string): Promise<void> {
    await this.json("POST", "/queues", { queue_name: name });
  }

  async createFreshM6Resources(input: ServiceConfig): Promise<void> {
    const config = serviceConfigSchema.parse(input);
    this.migrationWorkerPath(config);
    const source = stringifyToml(config);
    if (new TextEncoder().encode(source).length > 16384) throw new Error("Fresh M6 service configuration exceeds its runtime budget");
    const path = `/r2/buckets/${encodeURIComponent(config.bucket_name)}`;
    const bucket = await fetch(`${this.base}${path}`, { headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30000), redirect: "error" });
    if (bucket.body) await bucket.body.cancel();
    if (bucket.status !== 404) throw new Error("Fresh M6 resources require a new bucket; existing or unknown resources are not adopted");
    if (await this.existingWorker(config.worker_name)) throw new Error("Fresh M6 resources cannot adopt an existing Worker");
    await this.createBucket(config.bucket_name);
    await this.createQueue(config.queue_name);
    await this.createQueue(config.dlq_name);
    const response = await this.request("PUT", `/r2/buckets/${encodeURIComponent(config.bucket_name)}/objects/system/service.toml`, source, "application/toml");
    const result: ApiResult<unknown> = await response.json();
    if (!result.success) throw new Error("Fresh M6 service configuration upload did not succeed");
  }

  async uploadFreshM6Worker(input: ServiceConfig, source: string, adminKey: string, frozenMetadata: object): Promise<M6WorkerDeploymentEvidence> {
    const config = serviceConfigSchema.parse(input);
    const path = this.migrationWorkerPath(config);
    const metadata = buildM6WorkerUploadMetadata(config, null, adminKey, M6_FRESH_WORKER_COMPATIBILITY_DATE);
    const metadataSource = JSON.stringify(frozenMetadata);
    if (!source || workerPayloadHash(metadata) !== workerPayloadHash(metadataSource)) {
      throw new Error("Fresh M6 upload differs from its frozen runtime metadata");
    }
    await this.json("POST", "/workers/workers", { name: config.worker_name });
    const form = new FormData();
    form.set("metadata", metadataSource);
    form.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    const uploaded = await this.jsonUpload(`${path}?bindings_inherit=strict`, form);
    const deployment = workerDeploymentsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/deployments`)).deployments[0]!;
    if (deployment.versions.length !== 1 || deployment.versions[0]!.percentage !== 100) throw new Error("Fresh M6 Worker is not serving one version at 100%");
    const versionId = deployment.versions[0]!.version_id;
    await this.requireUploadedM6Version(path, versionId, uploaded);
    await this.disableMigrationWorkerPreviews(config, versionId);
    await this.ensureConsumer(await this.queueId(config.queue_name), config, false);
    await this.ensureConsumer(await this.queueId(config.dlq_name), config, true);
    await this.createNotification(config, await this.queueId(config.queue_name));
    const evidence = await this.inspectM6WorkerDeployment(config, versionId, M6_FRESH_WORKER_COMPATIBILITY_DATE);
    if (evidence.deployment_id !== deployment.id) throw new Error("Fresh M6 deployment changed after upload");
    return evidence;
  }

  async prepareCompatibleM6WorkerUpload(input: ServiceConfig, previousVersionId: string,
    expectedLatestVersionId = previousVersionId): Promise<M6WorkerUploadMetadata> {
    const config = serviceConfigSchema.parse(input);
    const path = this.workerPath(config);
    const domains = await this.compatibleDomainSnapshot(config);
    const previous = workerSettingsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/settings`));
    if (!previous.compatibility_date) throw new Error("Compatible update requires the existing runtime compatibility date");
    const evidence = await this.inspectM6WorkerDeployment(config, previousVersionId, previous.compatibility_date);
    const metadata = buildM6WorkerUploadMetadata(config, previous, "", previous.compatibility_date);
    const current = buildM6WorkerUploadMetadata(config, await this.json<unknown>("GET", `${path}/settings`), "", previous.compatibility_date);
    const deployment = await this.singleMigrationDeployment(path, previousVersionId);
    if (workerPayloadHash(current) !== workerPayloadHash(metadata) || deployment.id !== evidence.deployment_id ||
      await this.compatibleDomainSnapshot(config) !== domains) {
      throw new Error("M6 settings or deployment changed during compatible upload preparation");
    }
    await this.latestM6Version(path, expectedLatestVersionId);
    metadata.bindings = metadata.bindings.map((binding) => binding.type === "inherit" ? { ...binding, version_id: previousVersionId } : binding);
    return metadata;
  }

  async uploadCompatibleM6Worker(configInput: ServiceConfig, input: M6ServiceUpdateRequest, source: string,
    metadata: object, receipts?: M6UpdateDeployReceipts, beforeActivation?: () => Promise<void>): Promise<M6WorkerDeploymentEvidence> {
    const config = serviceConfigSchema.parse(configInput);
    const request = m6ServiceUpdateRequestSchema.parse(input);
    const metadataSource = JSON.stringify(metadata);
    if (config.service_id !== request.service_id || await m6ServiceConfigHash(config) !== request.service_config_sha256 ||
      workerPayloadHash(source) !== request.worker_source_sha256 || workerPayloadHash(metadataSource) !== request.worker_metadata_sha256) {
      throw new Error("Compatible upload differs from its frozen service, source or metadata");
    }
    const path = this.workerPath(config);
    const expected = await this.prepareCompatibleM6WorkerUpload(config, request.previous_worker_version_id);
    if (workerPayloadHash(expected) !== request.worker_metadata_sha256) throw new Error("Compatible settings changed after metadata was frozen");
    const previousDeployment = await this.singleMigrationDeployment(path, request.previous_worker_version_id);
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: expected.main_module, compatibility_date: expected.compatibility_date,
      compatibility_flags: expected.compatibility_flags, cache_options: expected.cache_options, exports: expected.exports,
      bindings: expected.bindings.map((binding) => binding.type === "inherit" ? { ...binding, version_id: "latest" } : binding) }));
    form.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    const previousVersion = await this.latestM6Version(path, request.previous_worker_version_id);
    const uploaded = workerVersionUploadReceiptSchema.parse(await this.jsonUpload(`${path}/versions?bindings_inherit=strict`, form, "POST"));
    const versionId = uploaded.id;
    if (versionId === request.previous_worker_version_id || uploaded.number !== previousVersion.number + 1) {
      throw new Error("Compatible upload did not acknowledge the next version after its exact inheritance source");
    }
    receipts?.uploaded(uploaded, previousDeployment.id);
    return this.activateCompatibleM6Worker(config, request, uploaded, previousDeployment.id, receipts, beforeActivation);
  }

  async activateCompatibleM6Worker(configInput: ServiceConfig, input: M6ServiceUpdateRequest, upload: WorkerVersionUploadReceipt,
    previousDeploymentId: string, receipts?: M6UpdateDeployReceipts, beforeActivation?: () => Promise<void>): Promise<M6WorkerDeploymentEvidence> {
    const config = serviceConfigSchema.parse(configInput);
    const request = m6ServiceUpdateRequestSchema.parse(input);
    const uploaded = workerVersionUploadReceiptSchema.parse(upload);
    m6RuntimeTargetSchema.shape.deployment_id.parse(previousDeploymentId);
    if (config.service_id !== request.service_id || await m6ServiceConfigHash(config) !== request.service_config_sha256 ||
      uploaded.id === request.previous_worker_version_id) throw new Error("Compatible activation has foreign configuration or upload receipt");
    const path = this.workerPath(config);
    const versionId = uploaded.id;
    for (let snapshot = 0; snapshot < 2; snapshot += 1) {
      await this.requireUploadedM6Version(path, versionId, uploaded.resources.script);
      const current = await this.prepareCompatibleM6WorkerUpload(config, request.previous_worker_version_id, versionId);
      if (workerPayloadHash(current) !== request.worker_metadata_sha256 ||
        (await this.singleMigrationDeployment(path, request.previous_worker_version_id)).id !== previousDeploymentId) {
        throw new Error("Compatible settings or deployment changed before activation; preserve the acknowledged version");
      }
      const versions = workerVersionsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/versions?page=1&per_page=2`)).items;
      if (versions[0]!.id !== versionId || versions[0]!.number !== uploaded.number ||
        versions[1]?.id !== request.previous_worker_version_id || versions[1].number !== uploaded.number - 1) {
        throw new Error("Compatible inheritance history changed; preserve the acknowledged version without deployment");
      }
    }
    await beforeActivation?.();
    receipts?.activating();
    const deployment = workerDeploymentsSnapshotSchema.shape.deployments.element.partial({ strategy: true, versions: true }).parse(await this.json<unknown>("POST", `${path}/deployments`, {
      strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }],
    }));
    if (deployment.versions && (deployment.versions.length !== 1 || deployment.versions[0]!.version_id !== versionId || deployment.versions[0]!.percentage !== 100)) {
      throw new Error("Compatible deployment did not acknowledge the uploaded version at 100%");
    }
    receipts?.deployed({ deployment_id: deployment.id, worker_version_id: versionId });
    return this.verifyCompatibleM6WorkerDeployment(config, request, uploaded, { deployment_id: deployment.id, worker_version_id: versionId,
      operation_id: request.operation_id, service_config_sha256: request.service_config_sha256 });
  }

  async verifyCompatibleM6WorkerDeployment(configInput: ServiceConfig, input: M6ServiceUpdateRequest, upload: WorkerVersionUploadReceipt,
    deploymentInput: M6RuntimeTarget): Promise<M6WorkerDeploymentEvidence> {
    const config = serviceConfigSchema.parse(configInput);
    const request = m6ServiceUpdateRequestSchema.parse(input);
    const uploaded = workerVersionUploadReceiptSchema.parse(upload);
    const deployment = m6RuntimeTargetSchema.parse(deploymentInput);
    if (config.service_id !== request.service_id || await m6ServiceConfigHash(config) !== request.service_config_sha256 ||
      deployment.operation_id !== request.operation_id || deployment.service_config_sha256 !== request.service_config_sha256 ||
      deployment.worker_version_id !== uploaded.id || uploaded.id === request.previous_worker_version_id) throw new Error("Compatible verification has foreign receipts");
    const path = this.workerPath(config);
    const versionId = uploaded.id;
    await this.requireUploadedM6Version(path, versionId, uploaded.resources.script);
    const versions = workerVersionsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/versions?page=1&per_page=2`)).items;
    if (versions[0]!.id !== versionId || versions[0]!.number !== uploaded.number || versions[1]?.id !== request.previous_worker_version_id ||
      versions[1].number !== uploaded.number - 1 || (await this.singleMigrationDeployment(path, versionId)).id !== deployment.deployment_id) {
      throw new Error("Compatible version history or acknowledged deployment changed during verification");
    }
    const preserved = await this.prepareCompatibleM6WorkerUpload(config, versionId);
    preserved.bindings = preserved.bindings.map((binding) => binding.type === "inherit" ? { ...binding, version_id: request.previous_worker_version_id } : binding);
    if (workerPayloadHash(preserved) !== request.worker_metadata_sha256) throw new Error("Compatible update changed the preserved Worker settings");
    const evidence = await this.inspectM6WorkerDeployment(config, versionId, preserved.compatibility_date);
    if (evidence.deployment_id !== deployment.deployment_id) throw new Error("Compatible deployment changed after upload");
    return evidence;
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

  async ensureWorkerDomain(hostname: string, service: string, beforeMutation?: () => Promise<void>): Promise<WorkerDomain> {
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
    if (existing.length > 1 || forService.length !== existing.length || existing[0] &&
      (existing[0].id !== forService[0]?.id || existing[0].zone_id !== forService[0]?.zone_id)) {
      throw new Error("Custom Domain lookups are inconsistent or ambiguous; do not adopt or overwrite them");
    }
    const zone = await this.zoneForHostname(hostname);
    if (existing.length) {
      if (beforeMutation) throw new Error("Do not adopt an existing domain without this operation's acknowledged receipt");
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
    if (beforeMutation) await beforeMutation();
    return this.json<WorkerDomain>("PUT", "/workers/domains", {
      hostname, service, zone_id: zone.id,
    });
  }

  async removeWorkerDomain(hostname: string, service: string, expectedId?: string): Promise<void> {
    hostname = normalizeHostname(hostname);
    const domains = await this.workerDomains("hostname", hostname);
    if (!domains.length && expectedId === undefined) return;
    if (domains.length !== 1 || domains[0].hostname !== hostname || domains[0].service !== service ||
      expectedId !== undefined && domains[0].id !== expectedId) {
      throw new Error(`Custom Domain ${hostname} is not owned by this Worker`);
    }
    const path = `/workers/domains/${encodeURIComponent(domains[0].id)}`;
    const response = await this.request("DELETE", path);
    const unconfirmed = `Cloudflare DELETE ${path} did not confirm deletion (HTTP ${response.status}); retain its connection token without replay`;
    if (response.status === 204) return;
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(unconfirmed);
    }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error(unconfirmed); }
    if (data !== null && (typeof data !== "object" || !("success" in data) || data.success !== true ||
      "errors" in data && (!Array.isArray(data.errors) || data.errors.length))) {
      throw new Error(unconfirmed);
    }
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

  async resolvePublicationQueue(configInput: ServiceConfig): Promise<string> {
    const config = serviceConfigSchema.parse(configInput);
    if (config.account_id !== this.accountId) throw new Error("Publication Queue belongs to another account");
    const id = publicationQueueIdSchema.parse(await this.queueId(config.queue_name));
    const value = await this.json<unknown>("GET", `/queues/${id}`);
    if (!value || typeof value !== "object" || !("queue_id" in value) || !("queue_name" in value) ||
      value.queue_id !== id || value.queue_name !== config.queue_name) throw new Error("Publication Queue identity was not verified");
    const consumers = await this.json<ConsumerRecord[]>("GET", `/queues/${id}/consumers`);
    if (!Array.isArray(consumers) || consumers.length !== 1 || !consumers[0] ||
      (consumers[0].script_name ?? consumers[0].script) !== config.worker_name || consumers[0].settings?.batch_size !== 1 ||
      consumers[0].settings?.max_concurrency !== 1 || consumers[0].settings?.max_retries !== 2 ||
      consumers[0].dead_letter_queue !== config.dlq_name) throw new Error("Publication Queue has an unknown or incompatible consumer");
    return id;
  }

  async publishManagementIntent(queueId: string, input: ManagementIntent): Promise<void> {
    const id = publicationQueueIdSchema.parse(queueId);
    const intent = parseManagementIntent(input);
    try { await this.json("POST", `/queues/${id}/messages`, { body: intent }); }
    catch (error) {
      throw new Error("Management submission was not acknowledged; preserve its frozen journal without retry or HTTP fallback", { cause: error });
    }
  }

  private async existingWorker(name: string): Promise<WorkerSettings | null> {
    const path = `/workers/scripts/${encodeURIComponent(name)}/settings`;
    const response = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare GET ${path} failed: HTTP ${response.status}`);
    const data: ApiResult<WorkerSettings> = await response.json();
    if (!data.success) throw new Error(`Cloudflare GET ${path} did not succeed`);
    return data.result;
  }

  async inspectM6WorkerDeployment(config: ServiceConfig, expectedVersionId: string,
    expectedCompatibilityDate = M6_WORKER_COMPATIBILITY_DATE): Promise<M6WorkerDeploymentEvidence> {
    return inspectM6WorkerDeployment(config, expectedVersionId, this.m6DeploymentReads(config), expectedCompatibilityDate);
  }

  async collectM6DeploymentSnapshot(config: ServiceConfig, expectedVersionId: string,
    expectedCompatibilityDate = M6_FRESH_WORKER_COMPATIBILITY_DATE): Promise<M6DeploymentSnapshot> {
    return collectM6DeploymentSnapshot(config, expectedVersionId, this.m6DeploymentReads(config), expectedCompatibilityDate);
  }

  private m6DeploymentReads(input: ServiceConfig): M6DeploymentReads {
    const config = serviceConfigSchema.parse(input);
    const path = this.workerPath(config);
    return {
      deployments: () => this.json<unknown>("GET", `${path}/deployments`),
      settings: () => this.json<unknown>("GET", `${path}/settings`),
      version: (versionId) => this.json<unknown>("GET", `${path}/versions/${encodeURIComponent(versionId)}`),
      subdomain: () => this.json<unknown>("GET", `${path}/subdomain`),
    };
  }

  private workerPath(input: ServiceConfig): string {
    const config = serviceConfigSchema.parse(input);
    if (config.account_id !== this.accountId) throw new Error("Worker targets another Cloudflare account; use this account's configured Worker");
    return `/workers/scripts/${encodeURIComponent(config.worker_name)}`;
  }

  private async compatibleDomainSnapshot(config: ServiceConfig): Promise<string> {
    const management = serviceManagementBaseUrl(config);
    const primary = new URL(config.public_base_url);
    const domains = await this.workerDomains("service", config.worker_name);
    const expected = primary.origin === management ? 0 : 1;
    if (domains.length !== expected || domains.some((domain) => domain.hostname !== primary.hostname || domain.service !== config.worker_name ||
      !domain.id || !domain.zone_id)) {
      throw new Error("Custom Domain connections differ from the configured primary Worker; no update is allowed");
    }
    return JSON.stringify(domains.map(({ id, hostname, service, zone_id }) => ({ id, hostname, service, zone_id })));
  }

  private migrationWorkerPath(input: ServiceConfig): string {
    const config = serviceConfigSchema.parse(input);
    const url = new URL(config.public_base_url);
    if (config.account_id !== this.accountId || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !url.hostname.startsWith(`${config.worker_name}.`) || !url.hostname.endsWith(".workers.dev")) {
      throw new Error("Migration REST deploy requires this account's existing workers.dev service; custom-domain/route migration is not released");
    }
    return this.workerPath(config);
  }

  private async singleMigrationDeployment(path: string, expectedVersionId: string) {
    m6RuntimeTargetSchema.shape.worker_version_id.parse(expectedVersionId);
    const value = workerDeploymentsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/deployments`)).deployments[0]!;
    if (value.versions.length !== 1 || value.versions[0]!.version_id !== expectedVersionId || value.versions[0]!.percentage !== 100) {
      throw new Error("Migration requires the expected single Worker version serving 100% before any write");
    }
    return value;
  }

  async disableMigrationWorkerPreviews(config: ServiceConfig, workerVersionId: string): Promise<void> {
    const path = this.migrationWorkerPath(config);
    await this.singleMigrationDeployment(path, workerVersionId);
    const result = workerSubdomainSnapshotSchema.parse(await this.json<unknown>("POST", `${path}/subdomain`, { enabled: true, previews_enabled: false }));
    if (!result.enabled || result.previews_enabled) throw new Error("Migration preview setting was not accepted");
  }

  private async requireUploadedM6Version(path: string, versionId: string, input: unknown): Promise<void> {
    const uploaded = workerScriptUploadReceiptSchema.parse(input);
    const version = workerVersionSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/versions/${encodeURIComponent(versionId)}`));
    if (version.id !== versionId || version.resources.script.etag !== uploaded.etag) {
      throw new Error("M6 deployed Worker content differs from its acknowledged upload; preserve the unknown deployment");
    }
  }

  private async latestM6Version(path: string, expectedVersionId: string): Promise<{ id: string; number: number }> {
    const latest = workerVersionsSnapshotSchema.parse(await this.json<unknown>("GET", `${path}/versions?page=1&per_page=2`)).items[0]!;
    if (latest.id !== expectedVersionId) throw new Error("Compatible inheritance requires the exact previous version to be the latest upload");
    return latest;
  }

  private async jsonUpload(path: string, body: FormData, method: "PUT" | "POST" = "PUT"): Promise<unknown> {
    const response = await this.request(method, path, body, undefined, 120000);
    const data: ApiResult<unknown> = await response.json();
    if (!data.success) throw new Error(`Cloudflare ${method} ${path} did not succeed`);
    return data.result;
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
}
