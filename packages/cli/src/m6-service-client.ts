import { m6ServiceAdminRequestSchema, m6ServiceAdminResponseSchema } from "@castloop/shared";
import type { M6ServiceAdminRequest, M6ServiceAdminResponse, ServiceConfig } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";

export class M6ServiceClient {
  private readonly admin: M6AdminJsonClient;
  constructor(config: ServiceConfig, adminKey: string, transport?: M6AdminTransport) {
    this.admin = new M6AdminJsonClient(config, adminKey, transport);
  }
  async call(input: M6ServiceAdminRequest): Promise<M6ServiceAdminResponse> {
    const request = m6ServiceAdminRequestSchema.parse(input);
    if (request.service_id !== this.admin.config.service_id) throw new Error("Service administration targets another service");
    const response = m6ServiceAdminResponseSchema.parse(await this.admin.post("service", request));
    if (JSON.stringify(response.request) !== JSON.stringify(request)) throw new Error("Service response differs from its frozen request");
    if (request.action === "pause" && (response.admission.state !== "paused" || response.admission.pause_id !== request.pause_id) ||
      request.action === "resume" && (response.admission.state !== "open" || response.admission.last_resumed_pause_id !== request.pause_id)) {
      throw new Error("Service response did not confirm its requested pause or resume");
    }
    return response;
  }
}
