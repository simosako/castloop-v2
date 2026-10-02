import { targetInspectionRequestSchema, targetInspectionResponseSchema } from "@castloop/shared";
import type { ServiceConfig, TargetInspectionRequest, TargetInspectionResponse } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";

export class TargetInspectionClient {
  private readonly http: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, transport: M6AdminTransport = fetch) {
    this.http = new M6AdminJsonClient(config, adminKey, transport);
  }

  async inspect(input: TargetInspectionRequest): Promise<TargetInspectionResponse> {
    const request = targetInspectionRequestSchema.parse(input);
    if (request.service_id !== this.http.config.service_id) throw new Error("Target inspection belongs to another service");
    const payload = await this.http.post("target", request);
    const response = targetInspectionResponseSchema.parse(payload);
    if (JSON.stringify(response.request) !== JSON.stringify(request)) throw new Error("Target inspection response belongs to another exact target");
    return response;
  }
}
