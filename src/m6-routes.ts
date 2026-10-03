import type { ServiceConfig } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import legacyWorker from "./index";
import { createCachedPublicFetch } from "./lifecycle-cache";
import type { CachedAssetBinding, LifecyclePurgeTarget } from "./lifecycle-cache";
import { handleM6LifecycleAdmin } from "./lifecycle-admin";
import { consumeLifecycleCommit } from "./lifecycle-consumer";
import { createM6DeliveryGate } from "./lifecycle-delivery-gate";
import { serveLifecyclePublicRequest } from "./lifecycle-gateway";
import { createLifecycleWorkerEffects, createPublicationWorkerEffects } from "./lifecycle-worker-effects";
import { parsePublicAssetPath } from "./public-assets";
import { handleM6PublicationAdmin } from "./publication-admin";
import { consumeOwnedPublication } from "./publication-consumer";
import { parseQueueDelivery, recordDeadLetterDelivery } from "./queue-delivery";
import { readServiceAdmission, requireM6ServiceRuntime, withServiceInvocation } from "./service-admission";
import { readServiceCapabilities } from "./service-capabilities";
import { handleM6StagingAdmin } from "./staging-admin";
import type { StageStreamDigest } from "./staging-verification";
import { readBootstrapDeliveryWindow } from "./migration-bootstrap";
import { handleMigrationAdmin } from "./migration-admin";
import type { BootstrapRuntime } from "./migration-bootstrap";
import { handleM6ShowRegistrationAdmin } from "./show-registration-admin";
import { handleM6TargetInspection } from "./target-inspection-admin";
import { handleM6SetupAdmin } from "./m6-setup-admin";
import type { M6SetupRuntime } from "./m6-setup-runtime";
import { handleM6ServiceAdmin } from "./m6-service-admin";
import { readM6ServiceConfiguration } from "./m6-runtime-readiness";
import { handleM6UpdateAdmin } from "./m6-update-admin";

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
  const { config } = await readM6ServiceConfiguration(env);
  if (config.dlq_name !== env.CASTLOOP_DLQ_NAME) throw new Error("M6 dead-letter binding does not match this service");
  return config;
}

async function requireCandidateReadiness(env: M6CandidateEnv, config: ServiceConfig): Promise<void> {
  await requireM6ServiceRuntime(env, config.service_id, env.CASTLOOP_VERSION_METADATA?.id);
}

async function deliveryMigration(env: M6CandidateEnv, config: ServiceConfig): Promise<string | undefined> {
  const current = await readServiceAdmission(env, config.service_id);
  if (current?.value.state === "migrating") {
    return readBootstrapDeliveryWindow(env, current.value, env.CASTLOOP_VERSION_METADATA?.id, env.CASTLOOP_VERSION_METADATA?.tag);
  }
  await requireCandidateReadiness(env, config);
  return undefined;
}

async function m6ManagementRoute(request: Request, env: M6CandidateEnv, cachedAssets: M6CachedLoopback,
  options: { digest?: StageStreamDigest }): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/admin/staging" && pathname !== "/admin/publication" && pathname !== "/admin/lifecycle" && pathname !== "/admin/shows" &&
    pathname !== "/admin/target" && pathname !== "/admin/service") return null;
  if (request.method !== "POST") return reply(request, { error: "method not allowed" }, 405);
  const bindings = { versionMetadata: env.CASTLOOP_VERSION_METADATA, gatewayProtocol: "m6-uncached-gateway-v1" as const, cachedAssets };
  if (pathname === "/admin/service") return handleM6ServiceAdmin(request, env);
  if (pathname === "/admin/target") return handleM6TargetInspection(request, env, bindings);
  if (pathname === "/admin/shows") return handleM6ShowRegistrationAdmin(request, env, bindings);
  if (pathname === "/admin/staging") return handleM6StagingAdmin(request, env, bindings, options);
  if (pathname === "/admin/publication") return handleM6PublicationAdmin(request, env, bindings);
  return handleM6LifecycleAdmin(request, env, bindings);
}

export async function fetchM6Candidate(request: Request, env: M6CandidateEnv,
  cachedAssets: M6CachedLoopback, bootstrapRuntime?: BootstrapRuntime): Promise<Response> {
  return fetchM6Routes(request, env, cachedAssets, false, bootstrapRuntime);
}

export async function fetchM6ManagementIntegration(request: Request, env: M6CandidateEnv,
  cachedAssets: M6CachedLoopback, options: { digest?: StageStreamDigest; setupRuntime?: M6SetupRuntime } = {}): Promise<Response> {
  return fetchM6Routes(request, env, cachedAssets, true, undefined, options);
}

async function fetchM6Routes(request: Request, env: M6CandidateEnv,
  cachedAssets: M6CachedLoopback, managementIntegration: boolean, bootstrapRuntime?: BootstrapRuntime,
  options: { digest?: StageStreamDigest; setupRuntime?: M6SetupRuntime } = {}): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const asset = parsePublicAssetPath(pathname);
  if (asset) {
    if (request.method !== "GET" && request.method !== "HEAD") return reply(request, { error: "method not allowed" }, 405);
    try {
      const config = await serviceConfig(env);
      const migrationId = await deliveryMigration(env, config);
      const response = await serveLifecyclePublicRequest(request, env, createCachedPublicFetch(cachedAssets));
      if (!response) throw new Error("M6 public path was not handled by its lifecycle gateway");
      const headers = new Headers(response.headers);
      headers.set("X-Castloop-Worker-Version", env.CASTLOOP_VERSION_METADATA.id);
      if (migrationId) headers.set("X-Castloop-Migration-ID", migrationId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      console.error(JSON.stringify({ event: "m6_candidate_public_failed", reason_code: "runtime_not_ready" }));
      return reply(request, { error: "temporarily unavailable" }, 503);
    }
  }
  if (!pathname.startsWith("/admin/")) return reply(request, { error: "not found" }, 404);
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply(request, { error: "unauthorized" }, 401);
  if (managementIntegration && options.setupRuntime) {
    const update = await handleM6UpdateAdmin(request, env);
    if (update) return update;
    const setup = await handleM6SetupAdmin(request, env, options.setupRuntime);
    if (setup) return setup;
  }
  if (bootstrapRuntime) {
    const migration = await handleMigrationAdmin(request, env, bootstrapRuntime);
    if (migration) return migration;
  }
  if (managementIntegration) {
    const management = await m6ManagementRoute(request, env, cachedAssets, options);
    if (management) return management;
  }
  if (request.method !== "GET") return reply(request, { error: "Mutation routes are not released on the M6 candidate" }, 409);
  if (pathname === "/admin/health") return reply(request, { result: "candidate", m6_ready: false,
    ...(options.setupRuntime ? { worker_version_id: env.CASTLOOP_VERSION_METADATA.id } : {}) }, 200);
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
