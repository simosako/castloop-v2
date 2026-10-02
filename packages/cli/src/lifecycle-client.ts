import { lifecycleAdminRequestSchema, lifecycleAdminResponseSchema, lifecycleCommitSchema } from "@castloop/shared";
import type { LifecycleAdminRequest, LifecycleAdminResponse, ServiceConfig } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";
import { createHash } from "node:crypto";

type Input<Action extends LifecycleAdminRequest["action"]> = Extract<LifecycleAdminRequest, { action: Action }>;
type Result<Name extends LifecycleAdminResponse["result"]> = Extract<LifecycleAdminResponse, { result: Name }>;
export type LifecycleAdminTransport = M6AdminTransport;

export class LifecycleAdminClient {
  private readonly config: ServiceConfig;
  private readonly http: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, transport: LifecycleAdminTransport = fetch) {
    this.http = new M6AdminJsonClient(config, adminKey, transport);
    this.config = this.http.config;
  }

  private async call(input: LifecycleAdminRequest, expected: LifecycleAdminResponse["result"]): Promise<LifecycleAdminResponse> {
    let request: LifecycleAdminRequest;
    try { request = lifecycleAdminRequestSchema.parse(input); }
    catch { throw new Error("Invalid lifecycle administrator request"); }
    const results = { "dry-run": "preview", status: "status", claim: "claimed", commit: "committed", retry: "requeued" } as const;
    if (results[request.action] !== expected) throw new Error("Lifecycle action differs from the requested client operation");
    if (request.service_id !== this.config.service_id) throw new Error("Lifecycle request belongs to another service");
    const hash = createHash("sha256").update(JSON.stringify(request.request)).digest("hex");
    const operation = lifecycleCommitSchema.parse({ schema_version: 1, job_id: request.request.job_id, show_id: request.request.show_id,
      kind: request.request.kind, ...(request.request.episode_id ? { episode_id: request.request.episode_id } : {}),
      action: request.request.action, show_generation: request.request.expected_show_generation + 1, request_sha256: hash });
    if (request.action !== "dry-run" && request.action !== "status" && request.confirmation.request_sha256 !== hash) {
      throw new Error("Lifecycle confirmation differs from its frozen request");
    }
    const payload = await this.http.post("lifecycle", request);
    try {
      const value = lifecycleAdminResponseSchema.parse(payload);
      if (value.service_id !== this.config.service_id || value.result !== expected) throw new Error("Lifecycle response identity/result mismatch");
      if (value.result === "preview") {
        if (JSON.stringify(value.request) !== JSON.stringify(request.request) || value.request_sha256 !== hash) {
          throw new Error("Lifecycle preview differs from its frozen request");
        }
        if (request.action !== "dry-run") throw new Error("Lifecycle preview is not an operation receipt");
        const page = value.deletion_page;
        if (request.request.action === "delete" && value.show && (request.request.kind === "show" || value.episode) && !page ||
          page && (page.scope_index !== (request.scope_index ?? 0) ||
            page.payload_objects + page.retained_marker_objects + page.unknown_objects > (request.maximum_objects ?? 100))) {
          throw new Error("Lifecycle preview differs from its bounded inventory page");
        }
      } else {
        if (JSON.stringify(value.operation) !== JSON.stringify(operation)) throw new Error("Lifecycle receipt differs from its frozen request");
      }
      return value;
    } catch {
      throw new Error("Lifecycle response was not verified; inspect retained ownership/progress without automatic retry");
    }
  }

  async dryRun(input: Input<"dry-run">): Promise<Result<"preview">> {
    const value = await this.call(input, "preview");
    if (value.result !== "preview") throw new Error("Invalid lifecycle preview result");
    return value;
  }

  async status(input: Input<"status">): Promise<Result<"status">> {
    const value = await this.call(input, "status");
    if (value.result !== "status") throw new Error("Invalid lifecycle status result");
    return value;
  }

  async claim(input: Input<"claim">): Promise<Result<"claimed">> {
    const value = await this.call(input, "claimed");
    if (value.result !== "claimed") throw new Error("Invalid lifecycle claim result");
    return value;
  }

  async commit(input: Input<"commit">): Promise<Result<"committed">> {
    const value = await this.call(input, "committed");
    if (value.result !== "committed") throw new Error("Invalid lifecycle commit result");
    return value;
  }

  async retry(input: Input<"retry">): Promise<Result<"requeued">> {
    const value = await this.call(input, "requeued");
    if (value.result !== "requeued") throw new Error("Invalid lifecycle requeue result");
    return value;
  }
}
