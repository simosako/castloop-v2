import { stageControlRequest, stagePayloadKey, stageUploadRequestSchema, stagingAdminRequestSchema,
  stagingAdminResponseSchema, stagingOperationSchema } from "@castloop/shared";
import type { ServiceConfig, StageReadbackReceipt, StageSettlement, StageUploadRequest, StagingAdminRequest, StagingAdminResponse, StagingOperation } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";
import { createHash } from "node:crypto";

type Result<Name extends StagingAdminResponse["result"]> = Extract<StagingAdminResponse, { result: Name }>;
export type StagePutTarget = Extract<StagingAdminResponse, { result: "started" }>["payloads"][number];

export function stagingClientOperation(input: StageUploadRequest): StagingOperation {
  const upload = stageUploadRequestSchema.parse(input);
  return stagingOperationSchema.parse({ show_id: upload.show_id, operation_id: upload.operation_id, show_generation: upload.expected_show_generation + 1 });
}

export function stagingClientTargets(input: StageUploadRequest): StagePutTarget[] {
  const upload = stageUploadRequestSchema.parse(input);
  return upload.payloads.map((payload) => ({ key: stagePayloadKey(upload, payload.asset), length: payload.length_bytes, sha256: payload.sha256 }));
}

export class StagingAdminClient {
  private readonly http: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, transport: M6AdminTransport = fetch) {
    this.http = new M6AdminJsonClient(config, adminKey, transport);
  }

  private async call(input: StageUploadRequest, action: StagingAdminRequest["action"],
    fields: { outcome?: "staged" | "aborted"; put_requests_settled?: true; no_more_puts?: true; readback_receipts?: StageReadbackReceipt[] } = {}): Promise<StagingAdminResponse> {
    const upload = stageUploadRequestSchema.parse(input);
    const operation = stagingClientOperation(upload);
    const identity = { schema_version: 1, service_id: this.http.config.service_id, action };
    const request = stagingAdminRequestSchema.parse(action === "claim" || action === "status" ? { ...identity, upload } :
      { ...identity, operation, ...fields });
    const expected = { claim: "claimed", status: "status", begin: "started", settle: "settled", finish: fields.outcome }[action];
    const payload = await this.http.post("staging", request);
    try {
      const value = stagingAdminResponseSchema.parse(payload);
      if (value.service_id !== this.http.config.service_id || value.result !== expected || JSON.stringify(value.operation) !== JSON.stringify(operation)) {
        throw new Error("Staging response differs from its frozen operation");
      }
      if (value.result === "started" && JSON.stringify(value.payloads) !== JSON.stringify(stagingClientTargets(upload))) {
        throw new Error("Staging PUT permission differs from its exact keys, sizes or checksums");
      }
      if (value.result === "status" && (JSON.stringify(value.upload) !== JSON.stringify(upload) ||
        value.manifest_sha256 !== createHash("sha256").update(JSON.stringify(upload)).digest("hex") ||
        value.request_sha256 !== createHash("sha256").update(JSON.stringify(stageControlRequest(upload))).digest("hex"))) {
        throw new Error("Staging status differs from its frozen manifest/control request");
      }
      return value;
    } catch {
      throw new Error("Staging response was not verified; inspect retained ownership/progress without automatic retry");
    }
  }

  async claim(upload: StageUploadRequest): Promise<Result<"claimed">> {
    const value = await this.call(upload, "claim");
    if (value.result !== "claimed") throw new Error("Invalid staging claim result");
    return value;
  }

  async begin(upload: StageUploadRequest): Promise<Result<"started">> {
    const value = await this.call(upload, "begin");
    if (value.result !== "started") throw new Error("Invalid staging begin result");
    return value;
  }

  async settle(upload: StageUploadRequest, evidence: StageSettlement): Promise<Result<"settled">> {
    const value = await this.call(upload, "settle", evidence);
    if (value.result !== "settled") throw new Error("Invalid staging settlement result");
    return value;
  }

  async finish(upload: StageUploadRequest, outcome: "staged" | "aborted"):
    Promise<Extract<StagingAdminResponse, { result: "staged" | "aborted" }>> {
    const value = await this.call(upload, "finish", { outcome });
    if (value.result !== "staged" && value.result !== "aborted") throw new Error("Invalid staging finish result");
    return value;
  }

  async status(upload: StageUploadRequest): Promise<Result<"status">> {
    const value = await this.call(upload, "status");
    if (value.result !== "status") throw new Error("Invalid staging status result");
    return value;
  }
}
