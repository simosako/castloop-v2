import { publicationAdminRequestSchema, publicationAdminResponseSchema } from "../packages/shared/src/index";
import type { PublicationAdminRequest, PublicationAdminResponse } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { M6ManagementServiceMismatch, withM6ManagementInvocation } from "./m6-management";
import { claimPublicationOperation, commitOwnedPublication } from "./publication-admission";

export type PublicationAdminEnv = LifecycleControlEnv & { CASTLOOP_ADMIN_KEY: string };

function reply(input: object, status = 200): Response {
  return Response.json(input, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleM6PublicationAdmin(request: Request, env: PublicationAdminEnv, bindings: M6DeliveryGateBindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/publication") return null;
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
  let input: PublicationAdminRequest;
  try { input = publicationAdminRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ error: "Invalid publication input", reason_code: "publication_input_invalid" }, 400); }
  try {
    const showId = input.action === "claim" ? input.publication.request.show_id : input.operation.show_id;
    const result = await withM6ManagementInvocation(env, input.service_id, input.action === "claim" ? "m6_admin" : "m6_recovery",
      { showId }, bindings, async (): Promise<PublicationAdminResponse> => {
        const identity = { schema_version: 1 as const, service_id: input.service_id };
        if (input.action === "claim") {
          const claimed = await claimPublicationOperation(env, input.publication);
          return publicationAdminResponseSchema.parse({ ...identity, result: "claimed", operation: {
            show_id: claimed.showId, job_id: claimed.jobId, show_generation: claimed.generation,
          } });
        }
        const committed = await commitOwnedPublication(env, { showId: input.operation.show_id,
          jobId: input.operation.job_id, generation: input.operation.show_generation });
        return publicationAdminResponseSchema.parse({ ...identity, result: "committed", operation: input.operation, ...committed });
      });
    return reply(result);
  } catch (error) {
    if (error instanceof M6ManagementServiceMismatch) return reply({ error: "Service ID mismatch", reason_code: "publication_input_invalid" }, 400);
    console.error(JSON.stringify({ event: "publication_operation_blocked", reason_code: "publication_operation_blocked" }));
    return reply({ error: "Publication operation blocked; inspect retained ownership and progress", reason_code: "publication_operation_blocked" }, 409);
  }
}
