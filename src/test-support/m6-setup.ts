import { buildM6WorkerUploadMetadata, collectM6DeploymentSnapshot, M6_FRESH_WORKER_COMPATIBILITY_DATE,
  m6ServiceConfigHash, stringifyToml } from "../../packages/shared/src/index";
import { describeCachedDeliveryRuntime } from "../lifecycle-delivery-gate";
import { fetchM6ManagementIntegration } from "../m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "../m6-routes";
import type { M6SetupRuntime } from "../m6-setup-runtime";
import { m6InitializationFixture } from "./m6-initialization";

export async function m6SetupFixture(options: { publicBaseUrl?: string } = {}) {
  const setup = await m6InitializationFixture();
  const config = { ...setup.config, public_base_url: options.publicBaseUrl ?? `https://${setup.config.worker_name}.example.workers.dev` };
  await setup.bucket.put("system/service.toml", stringifyToml(config));
  const request = { target: { ...setup.target, service_config_sha256: await m6ServiceConfigHash(config) } };
  const sent: unknown[] = [];
  const purges: string[] = [];
  const calls: string[] = [];
  const env: M6CandidateEnv = { CASTLOOP_BUCKET: setup.bucket as never,
    CASTLOOP_QUEUE: { send: async (body: unknown) => { sent.push(body); } } as never,
    CASTLOOP_ADMIN_KEY: "private-secret", CASTLOOP_DLQ_NAME: config.dlq_name,
    CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-03T12:00:00Z" } };
  const assets: M6CachedLoopback = Object.assign(() => ({ fetch: async () => new Response() }), {
    invalidate: async ({ showId }: { showId: string }) => { purges.push(showId); },
    describeRuntime: async () => describeCachedDeliveryRuntime(env.CASTLOOP_VERSION_METADATA, { purge: async () => ({ success: true, errors: [] }) }),
  });
  const runtime: M6SetupRuntime = { cachedRuntime: assets.describeRuntime, invalidate: (showId) => assets.invalidate({ showId }),
    defaultFetch: async (input) => { calls.push(new URL(input.url).pathname); return fetchM6ManagementIntegration(input, env, assets, { setupRuntime: runtime }); } };
  const metadata = buildM6WorkerUploadMetadata(config, null, env.CASTLOOP_ADMIN_KEY, M6_FRESH_WORKER_COMPATIBILITY_DATE);
  const snapshot = await collectM6DeploymentSnapshot(config, setup.versionId, {
    deployments: async () => ({ deployments: [{ id: setup.target.deployment_id, strategy: "percentage", versions: [{ version_id: setup.versionId, percentage: 100 }] }] }),
    settings: async () => metadata,
    subdomain: async () => ({ enabled: true, previews_enabled: false }),
    version: async () => ({ id: setup.versionId, resources: { bindings: metadata.bindings,
      script: { handlers: ["fetch", "queue"], named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
      script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags, exports: metadata.exports } } }),
  }, M6_FRESH_WORKER_COMPATIBILITY_DATE);
  const post = (route: string, body: unknown, key = env.CASTLOOP_ADMIN_KEY) => new Request(`${config.public_base_url}/admin/setup/${route}`, {
    method: "POST", headers: { "X-Castloop-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const run = (input: Request) => fetchM6ManagementIntegration(input, env, assets, { setupRuntime: runtime });
  const batch = (body: unknown, queue = config.queue_name) => ({ queue, messages: [{ body }] });
  return { ...setup, config, request, env, assets, runtime, snapshot, sent, purges, calls, post, run, batch };
}
