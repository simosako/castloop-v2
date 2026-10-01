import { parseServiceConfig } from "../packages/shared/src/index";
import type { ServiceConfig } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import legacyWorker from "./index";
import { createCachedPublicFetch } from "./lifecycle-cache";
import type { CachedAssetBinding, LifecyclePurgeTarget } from "./lifecycle-cache";
import { consumeLifecycleCommit } from "./lifecycle-consumer";
import { createM6DeliveryGate } from "./lifecycle-delivery-gate";
import { serveLifecyclePublicRequest } from "./lifecycle-gateway";
import { createLifecycleWorkerEffects, createPublicationWorkerEffects } from "./lifecycle-worker-effects";
import { parsePublicAssetPath } from "./public-assets";
import { consumeOwnedPublication } from "./publication-consumer";
import { parseQueueDelivery, recordDeadLetterDelivery } from "./queue-delivery";
import { readServiceAdmission, withServiceInvocation } from "./service-admission";
import { readServiceCapabilities } from "./service-capabilities";
import type { StageStreamDigest } from "./staging-verification";

export type M6CandidateEnv = {
  CASTLOOP_BUCKET: R2Bucket;
  CASTLOOP_QUEUE: Queue;
  CASTLOOP_DLQ_NAME: string;
  CASTLOOP_ADMIN_KEY: string;
  CASTLOOP_VERSION_METADATA: WorkerVersionMetadata;
};
export type M6CachedLoopback = CachedAssetBinding & {
  invalidate: (target: LifecyclePurgeTarget) => Promise<void>;
  describeRuntime: () => Promise<unknown>;
};

function reply(request: Request, data: object, status: number): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function serviceConfig(env: M6CandidateEnv): Promise<ServiceConfig> {
  const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!object || object.size < 1 || object.size > 16384) throw new Error("M6 service configuration is missing or oversized");
  const config = parseServiceConfig(await object.text());
  if (config.dlq_name !== env.CASTLOOP_DLQ_NAME) throw new Error("M6 dead-letter binding does not match this service");
  return config;
}

async function requireCandidateReadiness(env: M6CandidateEnv, config: ServiceConfig): Promise<void> {
  const current = await readServiceAdmission(env, config.service_id);
  if (current?.value.mode !== "m6" || current.value.state === "migrating" || !current.value.readiness ||
    current.value.readiness.worker_version_id !== env.CASTLOOP_VERSION_METADATA?.id) {
    throw new Error("M6 candidate requires verified migration readiness for this Worker version");
  }
}

export async function fetchM6Candidate(request: Request<unknown, IncomingRequestCfProperties>, env: M6CandidateEnv,
  cachedAssets: M6CachedLoopback): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const asset = parsePublicAssetPath(pathname);
  if (asset) {
    if (request.method !== "GET" && request.method !== "HEAD") return reply(request, { error: "method not allowed" }, 405);
    try {
      const config = await serviceConfig(env);
      await requireCandidateReadiness(env, config);
      const response = await serveLifecyclePublicRequest(request, env, createCachedPublicFetch(cachedAssets));
      if (!response) throw new Error("M6 public path was not handled by its lifecycle gateway");
      return response;
    } catch {
      console.error(JSON.stringify({ event: "m6_candidate_public_failed", reason_code: "runtime_not_ready" }));
      return reply(request, { error: "temporarily unavailable" }, 503);
    }
  }
  if (!pathname.startsWith("/admin/")) return reply(request, { error: "not found" }, 404);
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply(request, { error: "unauthorized" }, 401);
  if (request.method !== "GET") return reply(request, { error: "M6 candidate administration is read-only; mutation routes are not released" }, 409);
  if (pathname === "/admin/health") return reply(request, { result: "candidate", m6_ready: false }, 200);
  if (pathname === "/admin/capabilities") {
    try {
      return reply(request, await readServiceCapabilities(env, (await serviceConfig(env)).service_id, "m6_candidate"), 200);
    } catch {
      return reply(request, { error: "Service capabilities are unavailable" }, 503);
    }
  }
  if (pathname.startsWith("/admin/jobs/") || pathname.startsWith("/admin/episodes/") || pathname.startsWith("/admin/shows/")) {
    return legacyWorker.fetch(request, env);
  }
  return reply(request, { error: "not found" }, 404);
}

export async function queueM6Candidate(batch: MessageBatch<unknown>, env: M6CandidateEnv, cachedAssets: M6CachedLoopback,
  options: { digest?: StageStreamDigest; maximumObjects?: number } = {}): Promise<void> {
  if (batch.messages.length > 1) throw new Error("M6 candidate requires one-message Queue batches");
  if (!batch.messages.length) return;
  const config = await serviceConfig(env);
  if (batch.queue !== config.queue_name && batch.queue !== config.dlq_name) throw new Error("M6 candidate received an unknown Queue");
  await requireCandidateReadiness(env, config);
  for (const message of batch.messages) {
    const delivery = parseQueueDelivery(message.body);
    if (batch.queue !== config.dlq_name && !delivery) continue;
    await withServiceInvocation(env, config.service_id, "m6_consumer", async (invocation) => {
      const gate = createM6DeliveryGate(env, invocation, { versionMetadata: env.CASTLOOP_VERSION_METADATA,
        gatewayProtocol: "m6-uncached-gateway-v1", cachedAssets });
      if (batch.queue === config.dlq_name) {
        await gate({ showId: delivery?.target.show_id ?? "dlq-boundary", ...(delivery?.target.episode_id ? { episodeId: delivery.target.episode_id } : {}) });
        await recordDeadLetterDelivery(env, message);
      } else if (delivery?.family === "publication") {
        await consumeOwnedPublication(env, delivery.key, (execution) => createPublicationWorkerEffects(env, execution,
          { cachedAssets, checkDeliveryGate: gate }), options);
      } else if (delivery) {
        await consumeLifecycleCommit(env, delivery.key, (execution) => createLifecycleWorkerEffects(env, execution,
          { cachedAssets, checkDeliveryGate: gate, queue: env.CASTLOOP_QUEUE }), options);
      }
    });
  }
}
