import { m6ServiceUpdateRequestSchema, m6UpdateAdmittedSchema } from "@castloop/shared";
import type { M6RuntimeReadiness, M6RuntimeTarget, M6ServiceUpdateRequest, ServiceAdmission, ServiceConfig } from "@castloop/shared";
import type { CloudflareApi } from "./cloudflare-api";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";
import { M6ServiceClient } from "./m6-service-client";
import { M6SetupClient } from "./m6-setup-client";
import type { M6SetupWait } from "./m6-setup-client";

export class M6UpdateClient {
  private readonly admin: M6AdminJsonClient;
  private readonly service: M6ServiceClient;
  private readonly setup: M6SetupClient;
  constructor(config: ServiceConfig, adminKey: string, api: Pick<CloudflareApi, "collectM6DeploymentSnapshot">, transport?: M6AdminTransport) {
    this.admin = new M6AdminJsonClient(config, adminKey, transport);
    this.service = new M6ServiceClient(config, adminKey, transport);
    this.setup = new M6SetupClient(config, adminKey, api, transport);
  }
  async begin(input: M6ServiceUpdateRequest): Promise<void> {
    const request = m6ServiceUpdateRequestSchema.parse(input);
    if (request.service_id !== this.admin.config.service_id) throw new Error("Compatible update targets another service");
    const response = m6UpdateAdmittedSchema.parse(await this.admin.post("update/begin", { request }));
    if (JSON.stringify(response.request) !== JSON.stringify(request)) throw new Error("Compatible admission differs from its frozen request");
  }
  async admission(): Promise<ServiceAdmission> {
    return (await this.service.call({ service_id: this.admin.config.service_id, action: "status" })).admission;
  }
  async complete(request: M6ServiceUpdateRequest, target: M6RuntimeTarget, wait?: M6SetupWait): Promise<M6RuntimeReadiness> {
    if (request.service_id !== this.admin.config.service_id) throw new Error("Compatible completion targets another service");
    return this.setup.verifyUpdate(request, target, wait);
  }
  async observeCompleted(request: M6ServiceUpdateRequest, target: M6RuntimeTarget): Promise<M6RuntimeReadiness> {
    if (request.service_id !== this.admin.config.service_id) throw new Error("Compatible reconciliation targets another service");
    return this.setup.observeCompleted({ target, update_request: request });
  }
}
