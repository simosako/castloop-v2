import { inspectM6WorkerDeployment, M6_FRESH_WORKER_COMPATIBILITY_DATE, m6ServiceConfigHash, m6SetupCompletedSchema,
  m6SetupHealthSchema, m6SetupProbeSchema, m6SetupRequestSchema, m6SetupStatusSchema, m6SnapshotReads } from "@castloop/shared";
import type { M6RuntimeReadiness, M6RuntimeTarget, M6ServiceUpdateRequest, M6SetupRequest, ServiceConfig } from "@castloop/shared";
import type { CloudflareApi } from "./cloudflare-api";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";

export type M6SetupWait = { maximumReads: number; delay: () => Promise<void> };
const DEFAULT_WAIT: M6SetupWait = { maximumReads: 30, delay: () => new Promise((resolve) => setTimeout(resolve, 1000)) };

function requireSameRequest(actual: M6SetupRequest, expected: M6SetupRequest): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Setup response differs from its frozen initialization target");
}

export class M6SetupClient {
  private readonly admin: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, private readonly api: Pick<CloudflareApi, "collectM6DeploymentSnapshot">,
    transport: M6AdminTransport = fetch) {
    this.admin = new M6AdminJsonClient(config, adminKey, transport);
    const url = new URL(this.admin.config.public_base_url);
    if (url.port || url.hostname.split(".").length !== 4 || !url.hostname.startsWith(`${this.admin.config.worker_name}.`) || !url.hostname.endsWith(".workers.dev")) {
      throw new Error("Fresh M6 setup requires its matching workers.dev origin; custom-domain setup is not released");
    }
  }

  async initialize(input: M6RuntimeTarget, wait: M6SetupWait = DEFAULT_WAIT): Promise<M6RuntimeReadiness> {
    return this.verify({ target: input }, wait);
  }

  async verifyUpdate(update: M6ServiceUpdateRequest, target: M6RuntimeTarget, wait: M6SetupWait = DEFAULT_WAIT): Promise<M6RuntimeReadiness> {
    return this.verify({ target, update_request: update }, wait);
  }

  private async verify(input: M6SetupRequest, wait: M6SetupWait): Promise<M6RuntimeReadiness> {
    const request = m6SetupRequestSchema.parse(input);
    const config = this.admin.config;
    if (request.target.service_config_sha256 !== await m6ServiceConfigHash(config)) throw new Error("Setup target has another service configuration");
    if (!Number.isSafeInteger(wait.maximumReads) || wait.maximumReads < 1 || wait.maximumReads > 120) throw new Error("Invalid setup observation limit");
    const inspect = async () => {
      const snapshot = await this.api.collectM6DeploymentSnapshot(config, request.target.worker_version_id);
      const evidence = await inspectM6WorkerDeployment(config, request.target.worker_version_id, m6SnapshotReads(snapshot), M6_FRESH_WORKER_COMPATIBILITY_DATE);
      if (evidence.deployment_id !== request.target.deployment_id) throw new Error("Setup deployment changed from its frozen target");
      return snapshot;
    };
    const before = await inspect();
    let reachable = false;
    for (let read = 0; read < wait.maximumReads; read += 1) {
      try {
        const health = m6SetupHealthSchema.parse(await this.admin.getRuntimeHealth());
        if (health.worker_version_id !== request.target.worker_version_id) throw new Error("Another runtime version is reachable");
        reachable = true;
        break;
      } catch {
        if (read + 1 < wait.maximumReads) await wait.delay();
      }
    }
    if (!reachable) throw new Error("Expected setup Worker is not reachable; no preparation was sent");
    let status = m6SetupStatusSchema.parse(await this.admin.post("setup/prepare", request));
    requireSameRequest(status.record.request, request);
    for (let read = 0; !status.record.queue_receipt && read < wait.maximumReads; read += 1) {
      await wait.delay();
      status = m6SetupStatusSchema.parse(await this.admin.post("setup/status", request));
      requireSameRequest(status.record.request, request);
    }
    if (!status.record.queue_receipt) throw new Error("Setup Queue receipt is still pending; preserve initialization ownership without resending or releasing it");
    const probes = [];
    for (let check = 0; check < 2; check += 1) {
      const probe = m6SetupProbeSchema.parse(await this.admin.getSetupProbe(request.target.operation_id));
      requireSameRequest(probe.request, request);
      if (probe.cached_runtime.worker_version_id !== request.target.worker_version_id) throw new Error("External setup probe has another cache owner version");
      probes.push(probe);
    }
    if (probes[0]!.invocation_id === probes[1]!.invocation_id) throw new Error("External setup probe returned a repeated cached invocation");
    const after = await inspect();
    const completed = m6SetupCompletedSchema.parse(await this.admin.post("setup/complete", { ...request, snapshots: [before, after] }));
    requireSameRequest(completed.request, request);
    if (completed.result !== (request.update_request ? "updated" : "initialized")) throw new Error("Runtime completion acknowledged another operation kind");
    const { default_cache_disabled: _defaultCache, cached_entrypoint: _entrypoint, cutover_verified: _cutover,
      publication_routes_verified: _routes, ...target } = completed.readiness;
    requireSameRequest({ ...request, target }, request);
    return completed.readiness;
  }
}
