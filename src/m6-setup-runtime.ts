import { cachedDeliveryRuntimeSchema, m6RuntimeReadinessSchema, m6SetupProbeSchema, m6SetupRequestSchema } from "../packages/shared/src/index";
import type { M6RuntimeReadiness, M6SetupRequest } from "../packages/shared/src/index";
import { readBoundedAdminJson } from "./admin-body";
import type { M6InitializationEnv } from "./m6-service-initialization";
import { readM6SetupRecord, requireM6SetupOwner } from "./m6-setup-record";

export type M6SetupRuntime = {
  defaultFetch: (request: Request) => Promise<Response>;
  cachedRuntime: () => Promise<unknown>;
  invalidate: (showId: string) => Promise<void>;
};

export async function readM6SetupReply(response: Response, expectedStatus = 200): Promise<unknown> {
  try {
    if (response.status !== expectedStatus || response.headers.get("Cache-Control") !== "no-store" ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new Error("Invalid runtime probe response");
    return await readBoundedAdminJson(response);
  } catch {
    if (response.body && !response.bodyUsed) await response.body.cancel();
    throw new Error("Runtime probe response was not verified");
  }
}

export async function describeM6SetupProbe(env: M6InitializationEnv, input: M6SetupRequest, runtime: M6SetupRuntime): Promise<unknown> {
  const request = m6SetupRequestSchema.parse(input);
  await requireM6SetupOwner(env, request);
  if (!await readM6SetupRecord(env, request)) throw new Error("Runtime probe is not prepared");
  const cached = cachedDeliveryRuntimeSchema.parse(await runtime.cachedRuntime());
  if (cached.worker_version_id !== request.target.worker_version_id) throw new Error("Runtime probe has another cache owner version");
  return m6SetupProbeSchema.parse({ result: "runtime-probe", request, invocation_id: crypto.randomUUID(), cached_runtime: cached });
}

export async function verifyM6SetupRuntime(env: M6InitializationEnv & { CASTLOOP_ADMIN_KEY: string }, input: M6SetupRequest,
  runtime: M6SetupRuntime): Promise<M6RuntimeReadiness> {
  const request = m6SetupRequestSchema.parse(input);
  await requireM6SetupOwner(env, request);
  const record = await readM6SetupRecord(env, request);
  if (!record?.value.queue_receipt) throw new Error("Runtime verification requires its retained Queue round-trip receipt");
  const url = new URL("https://castloop.internal/admin/setup/probe");
  url.searchParams.set("operation_id", request.target.operation_id);
  const headers = { "X-Castloop-Key": env.CASTLOOP_ADMIN_KEY };
  const probes = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const probe = m6SetupProbeSchema.parse(await readM6SetupReply(await runtime.defaultFetch(new Request(url, { headers }))));
    if (JSON.stringify(probe.request) !== JSON.stringify(request) || probe.cached_runtime.worker_version_id !== request.target.worker_version_id) {
      throw new Error("Default entrypoint runtime probe differs from its frozen target");
    }
    probes.push(probe);
  }
  if (probes[0]!.invocation_id === probes[1]!.invocation_id) throw new Error("Default entrypoint returned a repeated runtime probe invocation");
  for (const [route, reason] of [["staging", "staging_input_invalid"], ["publication", "publication_input_invalid"],
    ["lifecycle", "lifecycle_input_invalid"], ["shows", "show_registration_input_invalid"], ["target", "target_input_invalid"]]) {
    const result = await readM6SetupReply(await runtime.defaultFetch(new Request(`https://castloop.internal/admin/${route}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
    })), 400);
    if (!result || typeof result !== "object" || !("reason_code" in result) || result.reason_code !== reason) {
      throw new Error("Runtime verification did not reach its compiled management validation route");
    }
  }
  for (const [path, status] of [["/podcasts/runtime-probe/feed.xml", 503], ["/system/service.toml", 404], ["/staging/runtime-probe", 404]] as const) {
    await readM6SetupReply(await runtime.defaultFetch(new Request(`https://castloop.internal${path}`)), status);
  }
  await requireM6SetupOwner(env, request);
  if ((await readM6SetupRecord(env, request))?.etag !== record.etag) throw new Error("Runtime verification record changed during its checks");
  return m6RuntimeReadinessSchema.parse({ ...request.target, default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
    cutover_verified: true, publication_routes_verified: true });
}
