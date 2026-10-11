import { domainAdminRequestSchema, domainAdminResponseSchema, domainRuntimeProbeSchema, m6ServiceConfigHash, serviceManagementBaseUrl } from "../packages/shared/src/index";
import type { DomainAdminRequest } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { requireM6ManagementRuntime } from "./m6-management";
import { readM6ServiceConfiguration } from "./m6-runtime-readiness";
import { readServiceAdmission } from "./service-admission";
import { beginServiceUrlChange, claimDomainConnection, completeServiceUrlChange, readServiceUrlChange,
  returnDomainConnection, stepServiceUrlChange } from "./service-url-change";
import type { ServiceUrlChangeBindings, ServiceUrlChangeEnv } from "./service-url-change";

async function snapshot(env: ServiceUrlChangeEnv, serviceId: string, bindings: ServiceUrlChangeBindings) {
  const current = await readM6ServiceConfiguration(env);
  const admission = await readServiceAdmission(env, serviceId);
  const ready = admission?.value.runtime_readiness ?? admission?.value.readiness;
  if (current.config.service_id !== serviceId || !admission || admission.value.mode !== "m6" || !ready ||
    !["paused", "open"].includes(admission.value.state) || ready.worker_version_id !== env.CASTLOOP_VERSION_METADATA.id) {
    throw new Error("Domain inspection requires the matching initialized M6 runtime");
  }
  await requireM6ManagementRuntime(bindings, ready);
  return { current, admission };
}

export async function handleDomainAdmin(request: Request, env: ServiceUrlChangeEnv & { CASTLOOP_ADMIN_KEY: string },
  bindings: ServiceUrlChangeBindings): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ reason_code: "domain_unauthorized" }, 401);
  if (request.method !== "POST") return reply({ reason_code: "domain_method_invalid" }, 405);
  let input: DomainAdminRequest;
  try { input = domainAdminRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ reason_code: "domain_input_invalid" }, 400); }
  try {
    const serviceId = input.action === "inspect" ? input.service_id : input.request.service_id;
    await snapshot(env, serviceId, bindings);
    if (input.action === "begin") await beginServiceUrlChange(env, input.request);
    else if (input.action === "step") await stepServiceUrlChange(env, input.request, bindings);
    else if (input.action === "complete") await completeServiceUrlChange(env, input.request, bindings);
    else if (input.action === "claim-connection") await claimDomainConnection(env, input.request, input.execution_id);
    else if (input.action === "return-connection") await returnDomainConnection(env, input.request, input.receipt);
    const { current, admission } = await snapshot(env, serviceId, bindings);
    const progress = input.action === "inspect" ? null : (await readServiceUrlChange(env, input.request))?.value ?? null;
    const configuration = await env.CASTLOOP_BUCKET.head("system/service.toml");
    const latest = await readServiceAdmission(env, serviceId);
    if (!configuration || configuration.etag !== current.etag || !latest || latest.etag !== admission.etag) {
      throw new Error("Domain snapshot changed during inspection");
    }
    return reply(domainAdminResponseSchema.parse({ result: "domain", request: input, worker_version_id: env.CASTLOOP_VERSION_METADATA.id,
      admission: admission.value, service_config_sha256: await m6ServiceConfigHash(current.config),
      public_base_url: current.config.public_base_url, workers_dev_base_url: serviceManagementBaseUrl(current.config), progress }));
  } catch {
    console.error(JSON.stringify({ event: "domain_operation_blocked", reason_code: "domain_operation_blocked" }));
    return reply({ reason_code: "domain_operation_blocked" }, 409);
  }
}

export async function serveDomainRuntimeProbe(request: Request, env: ServiceUrlChangeEnv,
  bindings: ServiceUrlChangeBindings): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
  if (request.method !== "GET") return new Response(null, { status: 405, headers });
  try {
    const nonce = domainRuntimeProbeSchema.shape.nonce.parse(new URL(request.url).searchParams.get("nonce"));
    const { config } = await readM6ServiceConfiguration(env);
    await snapshot(env, config.service_id, bindings);
    return Response.json(domainRuntimeProbeSchema.parse({ schema_version: 1, service_id: config.service_id,
      worker_name: config.worker_name, worker_version_id: env.CASTLOOP_VERSION_METADATA.id, nonce }), { headers });
  } catch { return Response.json({ reason_code: "domain_probe_unavailable" }, { status: 503, headers }); }
}
