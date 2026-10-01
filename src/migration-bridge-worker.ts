import { migrationBridgePreparationSchema, parseServiceConfig } from "../packages/shared/src/index";
import legacyWorker from "./index";
import { handleMigrationAdmin } from "./migration-admin";
import { readServiceAdmission } from "./service-admission";
import { parsePublicAssetPath } from "./public-assets";

type BridgeEnv = { CASTLOOP_BUCKET: R2Bucket; CASTLOOP_QUEUE: Queue; CASTLOOP_DLQ_NAME: string;
  CASTLOOP_ADMIN_KEY: string; CASTLOOP_VERSION_METADATA: WorkerVersionMetadata };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const bridgeId = migrationBridgePreparationSchema.shape.bridge_id.safeParse(env.CASTLOOP_VERSION_METADATA.tag);
    const migration = await handleMigrationAdmin(request, env, { workerVersionId: env.CASTLOOP_VERSION_METADATA.id,
      ...(bridgeId.success ? { workerBridgeId: bridgeId.data } : {}),
      protocol: "legacy_fenced", purgeDefaultCache: async () => {
        if (!ctx.cache) throw new Error("Bridge default-entrypoint cache purge is unavailable");
        return ctx.cache.purge({ purgeEverything: true });
      } });
    if (migration) return migration;
    const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
    if (!object || object.size > 16384) return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    const admission = await readServiceAdmission(env, parseServiceConfig(await object.text()).service_id);
    if (admission?.value.mode === "m6" || admission?.value.migration?.delivery_candidate) {
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (admission?.value.migration && parsePublicAssetPath(new URL(request.url).pathname) &&
      await env.CASTLOOP_BUCKET.head(`system/lifecycle-migrations/${admission.value.migration.migration_id}/plan.json`)) {
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const response = await legacyWorker.fetch(request, env);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("Cloudflare-CDN-Cache-Control");
    headers.delete("CDN-Cache-Control");
    headers.delete("Cache-Tag");
    headers.set("X-Castloop-Worker-Version", env.CASTLOOP_VERSION_METADATA.id);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch, env, ctx): Promise<void> { await legacyWorker.queue(batch, env, ctx); },
} satisfies ExportedHandler<BridgeEnv, unknown>;
