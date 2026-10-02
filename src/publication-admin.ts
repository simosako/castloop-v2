import { publicationAdminRequestSchema, publicationAdminResponseSchema, publicationManifestHash } from "../packages/shared/src/index";
import type { PublicationAdminRequest, PublicationAdminResponse } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { M6ManagementServiceMismatch, withM6ManagementInvocation, withM6ManagementRead } from "./m6-management";
import { claimPublicationOperation, commitOwnedPublication, requireOwnedPublication } from "./publication-admission";
import { inspectPublication } from "./publication-inspection";
import { requeuePublicationOperation } from "./publication-consumer";

export type PublicationAdminEnv = LifecycleControlEnv & { CASTLOOP_ADMIN_KEY: string;
  CASTLOOP_QUEUE: { send: (body: { object: { key: string } }) => Promise<unknown> } };

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
    if (input.action === "status") {
      return reply(await withM6ManagementRead(env, input.service_id, bindings, () => inspectPublication(env, input.service_id, input.publication)));
    }
    const showId = input.action === "claim" ? input.publication.request.show_id : input.operation.show_id;
    const result = await withM6ManagementInvocation(env, input.service_id, input.action === "claim" ? "m6_admin" : "m6_recovery",
      { showId }, bindings, async (): Promise<PublicationAdminResponse> => {
        const identity = { schema_version: 1 as const, service_id: input.service_id };
        if (input.action === "claim") {
          const claimed = await claimPublicationOperation(env, input.publication);
          return publicationAdminResponseSchema.parse({ ...identity, result: "claimed", manifest_sha256: await publicationManifestHash(input.publication), operation: {
            show_id: claimed.showId, job_id: claimed.jobId, show_generation: claimed.generation,
          } });
        }
        const operation = { showId: input.operation.show_id, jobId: input.operation.job_id, generation: input.operation.show_generation };
        const owned = await requireOwnedPublication(env, operation, { allowPublishedResult: input.action === "retry" });
        if (await publicationManifestHash(owned.frozen) !== input.manifest_sha256) throw new Error("Publication input differs from its retained manifest");
        if (input.action === "retry") {
          const key = await requeuePublicationOperation(env, operation, async (key) => { await env.CASTLOOP_QUEUE.send({ object: { key } }); });
          return publicationAdminResponseSchema.parse({ ...identity, result: "requeued", operation: input.operation,
            manifest_sha256: input.manifest_sha256, key });
        }
        const committed = await commitOwnedPublication(env, operation);
        return publicationAdminResponseSchema.parse({ ...identity, result: "committed", operation: input.operation,
          manifest_sha256: input.manifest_sha256, ...committed });
      });
    return reply(result);
  } catch (error) {
    if (error instanceof M6ManagementServiceMismatch) return reply({ error: "Service ID mismatch", reason_code: "publication_input_invalid" }, 400);
    console.error(JSON.stringify({ event: "publication_operation_blocked", reason_code: "publication_operation_blocked" }));
    return reply({ error: "Publication operation blocked; inspect retained ownership and progress", reason_code: "publication_operation_blocked" }, 409);
  }
}
