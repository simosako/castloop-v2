import { domainAdminRequestSchema, domainAdminResponseSchema, domainRuntimeProbeSchema } from "@castloop/shared";
import type { DomainAdminRequest, DomainAdminResponse, ServiceConfig } from "@castloop/shared";
import { M6AdminJsonClient, readM6JsonResponse } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";

export class DomainClient {
  private readonly admin: M6AdminJsonClient;
  private readonly transport: M6AdminTransport;
  constructor(config: ServiceConfig, key: string, transport: M6AdminTransport = fetch) {
    this.admin = new M6AdminJsonClient(config, key, transport);
    this.transport = transport;
  }

  async call(input: DomainAdminRequest): Promise<DomainAdminResponse> {
    const request = domainAdminRequestSchema.parse(input);
    const id = request.action === "inspect" ? request.service_id : request.request.service_id;
    if (id !== this.admin.config.service_id || request.action !== "inspect" && request.request.workers_dev_base_url !== this.admin.managementBaseUrl) {
      throw new Error("Domain administration targets another service or management origin");
    }
    const response = domainAdminResponseSchema.parse(await this.admin.post("domain", request));
    if (JSON.stringify(response.request) !== JSON.stringify(request) || response.admission.service_id !== id ||
      response.workers_dev_base_url !== this.admin.managementBaseUrl || request.action !== "inspect" &&
      (response.worker_version_id !== request.request.worker_version_id ||
        ![request.request.service_config_sha256, request.request.target_service_config_sha256].includes(response.service_config_sha256) ||
        response.progress && JSON.stringify(response.progress.request) !== JSON.stringify(request.request) ||
        response.admission.url_change && response.admission.url_change.operation_id !== request.request.operation_id)) {
      throw new Error("Domain response differs from its frozen request, configuration or runtime");
    }
    return response;
  }

  async verifyOrigin(origin: string, workerVersionId: string): Promise<void> {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
      throw new Error("TLS verification requires an HTTPS origin");
    }
    url.pathname = "/.well-known/castloop/runtime";
    const nonce = crypto.randomUUID();
    url.searchParams.set("nonce", nonce);
    let response: Response;
    try { response = await this.transport(url, { method: "GET", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(30000), headers: { Accept: "application/json" } }); }
    catch { throw new Error("Domain DNS/TLS is not verified; keep the service paused and retry the same operation after it is ready"); }
    if (response.status !== 200 || response.headers.get("Cache-Control") !== "no-store" ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
      if (response.body) await response.body.cancel();
      throw new Error("Domain did not reach the expected uncached Worker probe");
    }
    const probe = domainRuntimeProbeSchema.parse(await readM6JsonResponse(response, 4096));
    if (probe.nonce !== nonce || probe.service_id !== this.admin.config.service_id || probe.worker_name !== this.admin.config.worker_name ||
      probe.worker_version_id !== workerVersionId) throw new Error("Domain reached another Worker, service, version or cached probe");
  }
}
