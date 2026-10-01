import { parseServiceConfig, stagingAdminRequestSchema, stagingAdminResponseSchema } from "../packages/shared/src/index";
import type { StagingAdminRequest, StagingAdminResponse, StagingOperation } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { createM6DeliveryGate } from "./lifecycle-delivery-gate";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { withServiceInvocation } from "./service-admission";
import { beginStageUpload, claimStageUpload, settleStageUpload } from "./staging-upload";
import type { StageOperation } from "./staging-upload";
import { runStageVerification } from "./staging-verification";
import type { StageStreamDigest } from "./staging-verification";

export type StagingAdminEnv = LifecycleControlEnv & { CASTLOOP_ADMIN_KEY: string };

function reply(input: object, status = 200): Response {
  return Response.json(input, { status, headers: { "Cache-Control": "no-store" } });
}

function wireOperation(operation: StageOperation): StagingOperation {
  return { show_id: operation.showId, operation_id: operation.operationId, show_generation: operation.generation };
}

export async function handleM6StagingAdmin(request: Request, env: StagingAdminEnv, bindings: M6DeliveryGateBindings,
  options: { digest?: StageStreamDigest } = {}): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/staging") return null;
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
  let input: StagingAdminRequest;
  try { input = stagingAdminRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ error: "Invalid staging input", reason_code: "staging_input_invalid" }, 400); }
  try {
    const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
    if (!object || object.size < 1 || object.size > 16384) throw new Error("Invalid service configuration");
    const config = parseServiceConfig(await object.text());
    if (config.service_id !== input.service_id) return reply({ error: "Service ID mismatch", reason_code: "staging_input_invalid" }, 400);
    const kind = input.action === "claim" || input.action === "begin" ? "m6_admin" : "m6_recovery";
    const result = await withServiceInvocation(env, config.service_id, kind, async (invocation): Promise<StagingAdminResponse> => {
      const gate = createM6DeliveryGate(env, invocation, bindings);
      const showId = input.action === "claim" ? input.upload.show_id : input.operation.show_id;
      await gate({ showId });
      const identity = { schema_version: 1 as const, service_id: config.service_id };
      let response: StagingAdminResponse;
      if (input.action === "claim") {
        response = { ...identity, result: "claimed", operation: wireOperation(await claimStageUpload(env, input.upload)) };
      } else {
        const operation = { showId: input.operation.show_id, operationId: input.operation.operation_id, generation: input.operation.show_generation };
        if (input.action === "begin") {
          response = { ...identity, result: "started", operation: input.operation, payloads: await beginStageUpload(env, operation) };
        } else if (input.action === "settle") {
          await settleStageUpload(env, operation, input);
          response = { ...identity, result: "settled", operation: input.operation };
        } else {
          await runStageVerification(env, operation, input.outcome, options);
          response = { ...identity, result: input.outcome, operation: input.operation };
        }
      }
      await gate({ showId });
      return stagingAdminResponseSchema.parse(response);
    });
    return reply(result);
  } catch {
    console.error(JSON.stringify({ event: "staging_operation_blocked", reason_code: "staging_operation_blocked" }));
    return reply({ error: "Staging operation blocked; inspect retained ownership and progress", reason_code: "staging_operation_blocked" }, 409);
  }
}
