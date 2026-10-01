import { frozenMigrationPlanSchema, m6WorkerDeploymentEvidenceSchema, parseServiceConfig } from "../../packages/shared/src/index";
import { serveCachedLifecycleAsset } from "../lifecycle-cache";
import { describeCachedDeliveryRuntime } from "../lifecycle-delivery-gate";
import { runLifecycleMigrationStep } from "../lifecycle-migration-apply";
import { fetchM6Candidate } from "../m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "../m6-routes";
import { bootstrapHash, confirmMigrationQuiescence } from "../migration-bootstrap";
import type { BootstrapRuntime } from "../migration-bootstrap";
import { acquireServiceMigrationExecution, readServiceAdmission, releaseServiceMigrationExecution } from "../service-admission";
import type { ServiceMigrationExecution } from "../service-admission";
import { migrationFixture } from "./migration";

export async function bootstrapFixture(initialize = true) {
  const setup = await migrationFixture();
  const bridgeVersion = crypto.randomUUID();
  const candidateVersion = crypto.randomUUID();
  const purges: string[] = [];
  const calls: Request[] = [];
  const run = async <T>(callback: (execution: ServiceMigrationExecution) => Promise<T>): Promise<T> => {
    const execution = await acquireServiceMigrationExecution(setup.env, "service", setup.migrationId);
    try { return await callback(execution); }
    finally { await releaseServiceMigrationExecution(setup.env, execution); }
  };
  const bridge: BootstrapRuntime = { workerVersionId: bridgeVersion, protocol: "legacy_fenced", purgeDefaultCache: async () => {
    purges.push("bridge-default"); return { success: true, errors: [] };
  } };
  const quiescence = { schema_version: 1, service_id: "service", migration_id: setup.migrationId,
    request_sha256: (await readServiceAdmission(setup.env, "service"))!.value.migration!.request_sha256,
    bridge_worker_version_id: bridgeVersion, confirmed_at: "2026-10-01T12:00:00Z", old_admin_clients_stopped: true,
    old_worker_invocations_settled: true, old_rest_puts_settled: true, no_more_legacy_writes: true };
  if (initialize) {
    await run((execution) => confirmMigrationQuiescence(setup.env, execution, quiescence, bridge));
    await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects, { initializeOnly: true });
    await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects, { initializeOnly: true });
  }
  const bucket = { ...setup.bucket,
    async head(key: string) {
      const object = await setup.bucket.head(key);
      return object ? { ...object, httpEtag: `"${object.etag}"`, uploaded: new Date("2026-10-01T12:00:00Z") } : null;
    },
    async get(key: string, options?: { onlyIf?: { etagMatches: string }; range?: { offset: number; length: number } }) {
      const object = await setup.bucket.get(key);
      if (!object || options?.onlyIf && options.onlyIf.etagMatches !== object.etag) return null;
      const bytes = new TextEncoder().encode(await object.text());
      const body = options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes;
      return { ...object, httpEtag: `"${object.etag}"`, uploaded: new Date("2026-10-01T12:00:00Z"),
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close(); } }) };
    },
  };
  const env: M6CandidateEnv = { CASTLOOP_BUCKET: bucket, CASTLOOP_DLQ_NAME: "test-dlq", CASTLOOP_ADMIN_KEY: "private-key",
    CASTLOOP_VERSION_METADATA: { id: candidateVersion, tag: "", timestamp: "2026-10-01T12:00:00Z" },
    CASTLOOP_QUEUE: { send: async () => {} } } as never;
  const cached: M6CachedLoopback = Object.assign(({ props }: Parameters<M6CachedLoopback>[0]) => ({
    fetch: (request: Request) => serveCachedLifecycleAsset(request, env, props),
  }), { invalidate: async () => {}, describeRuntime: async () => describeCachedDeliveryRuntime({ id: candidateVersion },
    { purge: async () => ({ success: true, errors: [] }) }) });
  const candidate: BootstrapRuntime = { workerVersionId: candidateVersion, protocol: "m6_candidate", cachedRuntime: cached.describeRuntime,
    defaultFetch: async (request) => {
      calls.push(request);
      return fetchM6Candidate(new Request<unknown, IncomingRequestCfProperties>(request.url, {
        method: request.method, headers: request.headers,
      }), env, cached);
    } };
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const deployment = m6WorkerDeploymentEvidenceSchema.parse({ schema_version: 1, service_id: "service", account_id: config.account_id,
    worker_name: config.worker_name, deployment_id: crypto.randomUUID(), worker_version_id: candidateVersion,
    compatibility_date: "2026-10-01", traffic_percentage: 100, default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
    cached_entrypoint_enabled: true, cross_version_cache_disabled: true, version_metadata_binding_verified: true,
    service_bindings_verified: true, observability_enabled: true, workers_dev_previews_disabled: true });
  const plan = initialize ? frozenMigrationPlanSchema.parse(JSON.parse(setup.entries.get(`system/lifecycle-migrations/${setup.migrationId}/plan.json`)!.data)) : null;
  const bootstrapRequest = { schema_version: 1, service_id: "service", migration_id: setup.migrationId,
    request_sha256: quiescence.request_sha256, bootstrap_id: crypto.randomUUID(), plan_sha256: plan ? await bootstrapHash(plan) : "0".repeat(64),
    bridge_worker_version_id: bridgeVersion, worker_source_sha256: "a".repeat(64), worker_metadata_sha256: "b".repeat(64) };
  const settlement = { bootstrap_id: bootstrapRequest.bootstrap_id, rest_requests_settled: true, no_more_deploys: true, deployment };
  return { ...setup, env, run, bridge, candidate, cached, calls, purges, quiescence, bootstrapRequest, settlement,
    plan, candidateVersion, bridgeVersion, bootstrapKey: `system/lifecycle-migrations/${setup.migrationId}/bootstrap.json` };
}
