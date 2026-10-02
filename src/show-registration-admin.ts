import { showRegistrationRequestSchema } from "../packages/shared/src/index";
import type { ShowRegistrationRequest } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import { M6ManagementServiceMismatch, withM6ManagementInvocation, withM6ManagementRead } from "./m6-management";
import { inspectShowRegistration, reserveM6Show } from "./show-registration";
import type { ShowRegistrationEnv } from "./show-registration";

function reply(data: object, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleM6ShowRegistrationAdmin(request: Request, env: ShowRegistrationEnv & { CASTLOOP_ADMIN_KEY: string },
  bindings: M6DeliveryGateBindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/shows") return null;
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
  let input: ShowRegistrationRequest;
  try { input = showRegistrationRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ error: "Invalid Show registration input", reason_code: "show_registration_input_invalid" }, 400); }
  try {
    const result = input.action === "status" ? await withM6ManagementRead(env, input.service_id, bindings, () => inspectShowRegistration(env, input)) :
      await withM6ManagementInvocation(env, input.service_id, "m6_admin", { showId: input.show_id }, bindings, () => reserveM6Show(env, input));
    return reply(result);
  } catch (error) {
    if (error instanceof M6ManagementServiceMismatch) return reply({ error: "Service ID mismatch", reason_code: "show_registration_input_invalid" }, 400);
    console.error(JSON.stringify({ event: "show_registration_blocked", reason_code: "show_registration_blocked" }));
    return reply({ error: "Show registration blocked; inspect retained records", reason_code: "show_registration_blocked" }, 409);
  }
}
