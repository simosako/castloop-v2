import { m6UpdateAdmittedSchema, m6UpdateBeginSchema } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { beginM6ServiceUpdate } from "./m6-service-update";
import type { M6UpdateEnv } from "./m6-service-update";

export async function handleM6UpdateAdmin(request: Request, env: M6UpdateEnv & { CASTLOOP_ADMIN_KEY: string }): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/update/begin") return null;
  const reply = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ reason_code: "update_unauthorized" }, 401);
  if (request.method !== "POST") return reply({ reason_code: "update_method_invalid" }, 405);
  let input;
  try { input = m6UpdateBeginSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ reason_code: "update_input_invalid" }, 400); }
  try {
    await beginM6ServiceUpdate(env, input.request);
    return reply(m6UpdateAdmittedSchema.parse({ result: "update-admitted", request: input.request }), 200);
  } catch {
    console.error(JSON.stringify({ event: "m6_update_blocked", reason_code: "update_admission_blocked" }));
    return reply({ reason_code: "update_admission_blocked" }, 409);
  }
}
