import { showRegistrationRequestSchema, showRegistrationResponseSchema } from "@castloop/shared";
import type { ServiceConfig, ShowRegistrationRequest, ShowRegistrationResponse } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";

type Result<Name extends ShowRegistrationResponse["result"]> = Extract<ShowRegistrationResponse, { result: Name }>;

export class ShowRegistrationClient {
  private readonly http: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, transport: M6AdminTransport = fetch) {
    this.http = new M6AdminJsonClient(config, adminKey, transport);
  }

  private async call(input: ShowRegistrationRequest, action: "reserve" | "status"): Promise<ShowRegistrationResponse> {
    let request: ShowRegistrationRequest;
    try { request = showRegistrationRequestSchema.parse(input); }
    catch { throw new Error("Invalid Show registration request"); }
    if (request.service_id !== this.http.config.service_id || request.action !== action) throw new Error("Show registration service/action mismatch");
    const payload = await this.http.post("shows", request);
    try {
      const result = showRegistrationResponseSchema.parse(payload);
      if (result.service_id !== request.service_id || result.show_id !== request.show_id || result.reservation_id !== request.reservation_id ||
        result.result !== (action === "reserve" ? "reserved" : "status")) throw new Error("Show registration response mismatch");
      return result;
    } catch { throw new Error("Show registration response was not verified; inspect retained records without automatic retry"); }
  }

  async reserve(input: ShowRegistrationRequest): Promise<Result<"reserved">> {
    const result = await this.call(input, "reserve");
    if (result.result !== "reserved") throw new Error("Unexpected Show registration result");
    return result;
  }

  async status(input: ShowRegistrationRequest): Promise<Result<"status">> {
    const result = await this.call(input, "status");
    if (result.result !== "status") throw new Error("Unexpected Show registration status");
    return result;
  }
}
