import { m6ServiceAdminRequestSchema, m6ServiceAdminResponseSchema } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { readM6ServiceConfiguration } from "./m6-runtime-readiness";
import type { M6RuntimeEnv } from "./m6-runtime-readiness";
import { pauseServiceAdmission, readServiceAdmission, resumeServiceAdmission } from "./service-admission";
import { adminReply as reply } from "./admin-reply";

export async function handleM6ServiceAdmin(request: Request, env: M6RuntimeEnv & { CASTLOOP_ADMIN_KEY: string }): Promise<Response> {
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ reason_code: "service_unauthorized" }, 401);
  if (request.method !== "POST") return reply({ reason_code: "service_method_invalid" }, 405);
  let input;
  try { input = m6ServiceAdminRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ reason_code: "service_input_invalid" }, 400); }
  try {
    const { config } = await readM6ServiceConfiguration(env);
    if (config.service_id !== input.service_id) throw new Error("Another service was requested");
    if (input.action !== "status") {
      const change = input.action === "pause" ? pauseServiceAdmission : resumeServiceAdmission;
      await change(env, input.service_id, input.pause_id, env.CASTLOOP_VERSION_METADATA.id);
    }
    const admission = await readServiceAdmission(env, input.service_id);
    if (!admission) throw new Error("Service has no retained admission");
    return reply(m6ServiceAdminResponseSchema.parse({ result: "service", request: input,
      worker_version_id: env.CASTLOOP_VERSION_METADATA.id, external_episode_guids: true,
      ...(admission.value.runtime_readiness?.management_protocol ? { management_protocol: admission.value.runtime_readiness.management_protocol } : {}),
      publication_acceptance_protocol: "queue-validation-v1", publication_commit_protocol: "queue-commit-v1", admission: admission.value }));
  } catch {
    console.error(JSON.stringify({ event: "m6_service_blocked", reason_code: "service_operation_blocked" }));
    return reply({ reason_code: "service_operation_blocked" }, 409);
  }
}
