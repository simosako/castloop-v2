import { publicationAdminRequestSchema, publicationAdminResponseSchema, publicationCommitKey, publicationManifestHash,
  publicationOperationSchema, publicationRequestSchema } from "@castloop/shared";
import type { PublicationAdminResponse, PublicationOperationIdentity, PublicationRequest, ServiceConfig } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";
import { createHash } from "node:crypto";

type Result<Name extends PublicationAdminResponse["result"]> = Extract<PublicationAdminResponse, { result: Name }>;

export function publicationClientOperation(input: PublicationRequest): PublicationOperationIdentity {
  const request = publicationRequestSchema.parse(input).request;
  return publicationOperationSchema.parse({ show_id: request.show_id, job_id: request.job_id, show_generation: request.expected_show_generation + 1 });
}

export class PublicationAdminClient {
  private readonly http: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, transport: M6AdminTransport = fetch) {
    this.http = new M6AdminJsonClient(config, adminKey, transport);
  }

  private async call(input: PublicationRequest, action: "claim" | "commit" | "retry" | "status"): Promise<PublicationAdminResponse> {
    const publication = publicationRequestSchema.parse(input);
    const operation = publicationClientOperation(publication);
    const hash = await publicationManifestHash(publication);
    const identity = { schema_version: 1, service_id: this.http.config.service_id, action };
    const request = publicationAdminRequestSchema.parse(action === "commit" || action === "retry" ? { ...identity, operation, manifest_sha256: hash } :
      { ...identity, publication });
    const payload = await this.http.post("publication", request);
    try {
      const value = publicationAdminResponseSchema.parse(payload);
      const expected = { claim: "claimed", commit: "committed", retry: "requeued", status: "status" }[action];
      if (value.service_id !== this.http.config.service_id || value.result !== expected || value.manifest_sha256 !== hash ||
        JSON.stringify(value.operation) !== JSON.stringify(operation) || (value.result === "committed" || value.result === "requeued") && value.key !== publicationCommitKey(publication.commit) ||
        value.result === "status" && (JSON.stringify(value.publication) !== JSON.stringify(publication) ||
          value.request_sha256 !== createHash("sha256").update(JSON.stringify(publication.request)).digest("hex"))) {
        throw new Error("Publication response differs from its frozen manifest/control request");
      }
      return value;
    } catch {
      throw new Error("Publication response was not verified; inspect retained ownership/progress without automatic retry");
    }
  }

  async claim(publication: PublicationRequest): Promise<Result<"claimed">> {
    const value = await this.call(publication, "claim");
    if (value.result !== "claimed") throw new Error("Invalid publication claim result");
    return value;
  }

  async commit(publication: PublicationRequest): Promise<Result<"committed">> {
    const value = await this.call(publication, "commit");
    if (value.result !== "committed") throw new Error("Invalid publication commit result");
    return value;
  }

  async status(publication: PublicationRequest): Promise<Result<"status">> {
    const value = await this.call(publication, "status");
    if (value.result !== "status") throw new Error("Invalid publication status result");
    return value;
  }

  async retry(publication: PublicationRequest): Promise<Result<"requeued">> {
    const value = await this.call(publication, "retry");
    if (value.result !== "requeued") throw new Error("Invalid publication retry result");
    return value;
  }
}
