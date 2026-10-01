import { frozenMigrationPlanSchema, migrationApplyProgressSchema, migrationBootstrapRequestSchema, migrationBootstrapSchema,
  migrationDeploymentSettlementSchema, migrationQuiescenceSchema, parseServiceConfig } from "../packages/shared/src/index";
import type { FrozenMigrationPlan, MigrationBootstrap, ServiceAdmission } from "../packages/shared/src/index";
import type { MigrationApplyEnv } from "./lifecycle-migration-apply";
import { verifyMigrationInventory } from "./lifecycle-migration-apply";
import { openMigrationDeliveryCandidate, requireServiceMigration } from "./service-admission";
import type { ServiceMigrationExecution } from "./service-admission";
import { cachedDeliveryRuntimeSchema } from "../packages/shared/src/index";
import { parsePublicAssetPath } from "./public-assets";

export type BootstrapRuntime = { workerVersionId: string; protocol: "legacy_fenced" | "m6_candidate";
  cachedRuntime?: () => Promise<unknown>; defaultFetch?: (request: Request) => Promise<Response>;
  purgeDefaultCache?: () => Promise<CachePurgeResult> };

function prefix(execution: ServiceMigrationExecution): string { return `system/lifecycle-migrations/${execution.migrationId}`; }
export async function bootstrapHash(input: unknown): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedObject(env: MigrationApplyEnv, key: string, maximum = 16384) {
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (object && (object.size < 1 || object.size > maximum)) throw new Error("Migration operational record is oversized or empty");
  return object;
}

export async function confirmMigrationQuiescence(env: MigrationApplyEnv, execution: ServiceMigrationExecution, input: unknown,
  runtime: BootstrapRuntime): Promise<void> {
  const owner = await requireServiceMigration(env, execution);
  const confirmation = migrationQuiescenceSchema.parse(input);
  if (runtime.protocol !== "legacy_fenced" || confirmation.bridge_worker_version_id !== runtime.workerVersionId ||
    confirmation.service_id !== execution.serviceId || confirmation.migration_id !== execution.migrationId ||
    confirmation.request_sha256 !== owner.value.migration!.request_sha256) throw new Error("Quiescence declaration does not match this migration bridge");
  const key = `${prefix(execution)}/quiescence.json`;
  await requireServiceMigration(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(confirmation), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!written) {
    const object = await boundedObject(env, key);
    if (!object || JSON.stringify(migrationQuiescenceSchema.parse(await object.json<unknown>())) !== JSON.stringify(confirmation)) {
      throw new Error("Migration already has another frozen quiescence declaration");
    }
  }
}

export async function requireMigrationQuiescence(env: MigrationApplyEnv, execution: ServiceMigrationExecution): Promise<void> {
  const owner = await requireServiceMigration(env, execution);
  const object = await boundedObject(env, `${prefix(execution)}/quiescence.json`);
  if (!object) throw new Error("Migration requires an explicit old-client, old-invocation and old-PUT settlement declaration");
  const value = migrationQuiescenceSchema.parse(await object.json<unknown>());
  if (value.service_id !== execution.serviceId || value.migration_id !== execution.migrationId ||
    value.request_sha256 !== owner.value.migration!.request_sha256) throw new Error("Quiescence belongs to another migration");
}

async function initializedPlan(env: MigrationApplyEnv, execution: ServiceMigrationExecution): Promise<FrozenMigrationPlan> {
  const owner = await requireServiceMigration(env, execution);
  const object = await boundedObject(env, `${prefix(execution)}/plan.json`, 8_000_000);
  const progressObject = await boundedObject(env, `${prefix(execution)}/progress.json`);
  if (!object || !progressObject) throw new Error("Bootstrap requires a frozen and initialized migration plan");
  const plan = frozenMigrationPlanSchema.parse(await object.json<unknown>());
  const progress = migrationApplyProgressSchema.parse(await progressObject.json<unknown>());
  if (plan.service_id !== execution.serviceId || plan.migration_id !== execution.migrationId || plan.request_sha256 !== owner.value.migration!.request_sha256 ||
    progress.service_id !== plan.service_id || progress.migration_id !== plan.migration_id || progress.request_sha256 !== plan.request_sha256 ||
    progress.plan_sha256 !== await bootstrapHash(plan) || !["runtime", "finished"].includes(progress.phase) ||
    progress.next_target !== plan.shows.reduce((count, show) => count + show.episodes.length + 1, 0)) {
    throw new Error("Bootstrap plan does not have complete owned initialization evidence");
  }
  await verifyMigrationInventory(env, execution, plan, true);
  return plan;
}

export async function readMigrationBootstrap(env: MigrationApplyEnv, execution: ServiceMigrationExecution): Promise<{ value: MigrationBootstrap; etag: string } | null> {
  const owner = await requireServiceMigration(env, execution);
  const object = await boundedObject(env, `${prefix(execution)}/bootstrap.json`);
  if (!object) return null;
  const value = migrationBootstrapSchema.parse(await object.json<unknown>());
  if (value.request.service_id !== execution.serviceId || value.request.migration_id !== execution.migrationId ||
    value.request.request_sha256 !== owner.value.migration!.request_sha256) throw new Error("Bootstrap belongs to another migration");
  return { value, etag: object.etag };
}

async function saveBootstrap(env: MigrationApplyEnv, execution: ServiceMigrationExecution, input: MigrationBootstrap,
  previous: { value: MigrationBootstrap; etag: string } | null): Promise<void> {
  await requireServiceMigration(env, execution);
  const value = migrationBootstrapSchema.parse(input);
  if (previous && (JSON.stringify(previous.value.request) !== JSON.stringify(value.request) || value.next_asset < previous.value.next_asset ||
    ["prepared", "deploying", "verifying", "verified"].indexOf(value.phase) < ["prepared", "deploying", "verifying", "verified"].indexOf(previous.value.phase))) {
    throw new Error("Frozen bootstrap request or progress cannot regress");
  }
  if (!await env.CASTLOOP_BUCKET.put(`${prefix(execution)}/bootstrap.json`, JSON.stringify(value), {
    onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
  })) throw new Error("Bootstrap progress CAS conflicted");
}

export async function prepareBootstrapDeployment(env: MigrationApplyEnv, execution: ServiceMigrationExecution, input: unknown,
  runtime: BootstrapRuntime): Promise<void> {
  await requireMigrationQuiescence(env, execution);
  const plan = await initializedPlan(env, execution);
  const request = migrationBootstrapRequestSchema.parse(input);
  const confirmation = migrationQuiescenceSchema.parse(await (await boundedObject(env, `${prefix(execution)}/quiescence.json`))!.json<unknown>());
  if (runtime.protocol !== "legacy_fenced" || request.bridge_worker_version_id !== runtime.workerVersionId ||
    request.bridge_worker_version_id !== confirmation.bridge_worker_version_id || request.service_id !== execution.serviceId ||
    request.migration_id !== execution.migrationId || request.request_sha256 !== plan.request_sha256 || request.plan_sha256 !== await bootstrapHash(plan)) {
    throw new Error("Bootstrap request does not match the initialized migration and bridge");
  }
  const existing = await readMigrationBootstrap(env, execution);
  if (existing) {
    if (JSON.stringify(existing.value.request) === JSON.stringify(request)) return;
    throw new Error("Migration already has a different frozen bootstrap request");
  }
  await saveBootstrap(env, execution, { schema_version: 1, request, phase: "prepared", next_asset: 0, checks_sha256: "0".repeat(64) }, null);
}

export async function beginBootstrapDeployment(env: MigrationApplyEnv, execution: ServiceMigrationExecution, bootstrapId: string,
  runtime: BootstrapRuntime): Promise<{ bootstrap_id: string; start_allowed: true }> {
  await requireMigrationQuiescence(env, execution);
  await initializedPlan(env, execution);
  const previous = await readMigrationBootstrap(env, execution);
  if (!previous || previous.value.request.bootstrap_id !== bootstrapId || previous.value.phase !== "prepared" ||
    runtime.protocol !== "legacy_fenced" || previous.value.request.bridge_worker_version_id !== runtime.workerVersionId) {
    throw new Error("Bootstrap deployment has no unused start authorization on this bridge");
  }
  if (!runtime.purgeDefaultCache) throw new Error("Bootstrap start requires the bridge default-entrypoint purge binding");
  await requireServiceMigration(env, execution);
  const purge = await runtime.purgeDefaultCache();
  if (!purge.success || purge.errors.length) throw new Error("Bridge default-entrypoint cache purge failed");
  await requireServiceMigration(env, execution);
  await saveBootstrap(env, execution, { ...previous.value, phase: "deploying", old_cache_purged_by_execution_id: execution.executionId }, previous);
  return { bootstrap_id: bootstrapId, start_allowed: true };
}

async function requireCandidate(runtime: BootstrapRuntime, versionId: string): Promise<void> {
  if (runtime.protocol !== "m6_candidate" || runtime.workerVersionId !== versionId || !runtime.cachedRuntime) throw new Error("Bootstrap requires the executing candidate Worker version");
  const cached = cachedDeliveryRuntimeSchema.parse(await runtime.cachedRuntime());
  if (cached.worker_version_id !== versionId) throw new Error("Bootstrap cache owner belongs to another Worker version");
}

export async function settleBootstrapDeployment(env: MigrationApplyEnv, execution: ServiceMigrationExecution, input: unknown,
  runtime: BootstrapRuntime): Promise<void> {
  await requireMigrationQuiescence(env, execution);
  const plan = await initializedPlan(env, execution);
  const settlement = migrationDeploymentSettlementSchema.parse(input);
  const previous = await readMigrationBootstrap(env, execution);
  if (!previous || previous.value.request.bootstrap_id !== settlement.bootstrap_id || previous.value.phase === "prepared" ||
    previous.value.request.plan_sha256 !== await bootstrapHash(plan)) throw new Error("Deployment settlement does not match its started bootstrap");
  const serviceObject = await boundedObject(env, "system/service.toml");
  if (!serviceObject) throw new Error("Published service config is missing");
  const config = parseServiceConfig(await serviceObject.text());
  if (settlement.deployment.service_id !== config.service_id || settlement.deployment.account_id !== config.account_id ||
    settlement.deployment.worker_name !== config.worker_name) throw new Error("Deployment evidence belongs to another service");
  await requireCandidate(runtime, settlement.deployment.worker_version_id);
  await requireServiceMigration(env, execution);
  if (previous.value.settlement) {
    if (JSON.stringify(previous.value.settlement) !== JSON.stringify(settlement)) throw new Error("Frozen deployment settlement cannot change");
  } else await saveBootstrap(env, execution, { ...previous.value, phase: "verifying", settlement }, previous);
  await openMigrationDeliveryCandidate(env, execution, { bootstrap_id: settlement.bootstrap_id, worker_version_id: settlement.deployment.worker_version_id,
    deployment_id: settlement.deployment.deployment_id, plan_sha256: previous.value.request.plan_sha256 });
}

export async function verifyBootstrapDeliveryStep(env: MigrationApplyEnv, execution: ServiceMigrationExecution, runtime: BootstrapRuntime,
  maximumAssets = 2): Promise<{ state: "pending" | "verified"; next_asset: number }> {
  if (!Number.isSafeInteger(maximumAssets) || maximumAssets < 1 || maximumAssets > 20) throw new Error("Invalid bootstrap HTTP step size");
  await requireMigrationQuiescence(env, execution);
  const plan = await initializedPlan(env, execution);
  const previous = await readMigrationBootstrap(env, execution);
  if (!previous?.value.settlement || !["verifying", "verified"].includes(previous.value.phase)) throw new Error("Bootstrap deployment is not settled for verification");
  await requireCandidate(runtime, previous.value.settlement.deployment.worker_version_id);
  if (!runtime.defaultFetch) throw new Error("Bootstrap requires an actual default-entrypoint fetch binding");
  const owner = await requireServiceMigration(env, execution);
  const candidate = owner.value.migration!.delivery_candidate;
  if (!candidate || candidate.bootstrap_id !== previous.value.request.bootstrap_id || candidate.worker_version_id !== runtime.workerVersionId ||
    candidate.plan_sha256 !== await bootstrapHash(plan)) throw new Error("Bootstrap delivery window is not owned by this candidate");
  const assets = plan.sources.filter((source) => source.key.startsWith("public/") && parsePublicAssetPath(source.key.slice(6)));
  if (previous.value.next_asset > assets.length) throw new Error("Bootstrap HTTP progress exceeds its frozen asset inventory");
  if (previous.value.phase === "verified") {
    if (previous.value.next_asset !== assets.length) throw new Error("Bootstrap HTTP verification is incomplete");
    return { state: "verified", next_asset: assets.length };
  }
  let checksum = previous.value.checks_sha256;
  const end = Math.min(assets.length, previous.value.next_asset + maximumAssets);
  for (let index = previous.value.next_asset; index < end; index += 1) {
    const source = assets[index]!;
    const asset = parsePublicAssetPath(source.key.slice(6))!;
    const show = plan.shows.find((show) => show.show_id === asset.showId)!;
    const episode = asset.kind === "audio" ? show?.episodes.find((episode) => episode.episode_id === asset.episodeId) : undefined;
    if (!show || asset.kind === "audio" && !episode) throw new Error("HTTP probe has no frozen lifecycle target");
    const status = ["deleted", "deleting"].includes(show.value.lifecycle) ? 410 : show.value.lifecycle !== "active" ? 404 :
      episode && ["deleted", "deleting"].includes(episode.value.lifecycle) ? 410 : episode && episode.value.lifecycle !== "active" ? 404 : 200;
    await requireServiceMigration(env, execution);
    const observations = await probeAsset(runtime, source, status, execution.migrationId);
    await requireServiceMigration(env, execution);
    checksum = await bootstrapHash({ previous: checksum, key: source.key, observations });
  }
  await verifyMigrationInventory(env, execution, plan, true);
  await saveBootstrap(env, execution, { ...previous.value, next_asset: end, checks_sha256: checksum,
    ...(end === assets.length ? { phase: "verified", verified_by_execution_id: execution.executionId } : {}) }, previous);
  return { state: end === assets.length ? "verified" : "pending", next_asset: end };
}

async function probeAsset(runtime: BootstrapRuntime, source: { key: string; etag: string; size: number }, status: number,
  migrationId: string): Promise<number[]> {
  const observations: number[] = [];
  const path = source.key.slice(6);
  const etag = `"${source.etag}"`;
  for (const [method, headers, expected] of [["HEAD", {}, status], ["GET", {}, status],
    ["GET", { Range: "bytes=0-0" }, status === 200 ? 206 : status],
    ["GET", { "If-None-Match": etag }, status === 200 ? 304 : status]] as const) {
    const response = await runtime.defaultFetch!(new Request(`https://castloop-migration.invalid${path}`, { method, headers }));
    try {
      if (response.status !== expected || response.headers.get("X-Castloop-Worker-Version") !== runtime.workerVersionId ||
        response.headers.get("X-Castloop-Migration-ID") !== migrationId ||
        response.headers.get("Cache-Control") !== (status === 200 ? "public, max-age=0, must-revalidate" : "no-store")) {
        throw new Error("Default-entrypoint HTTP probe failed its state, version or revalidation check");
      }
      if (status === 200 && response.headers.get("ETag") !== etag) throw new Error("Public HTTP asset does not match its frozen source ETag");
      if (status === 200 && (method === "HEAD" || expected === 200) && response.headers.get("Content-Length") !== String(source.size)) {
        throw new Error("Public HTTP asset size does not match its frozen source");
      }
      if (expected === 206 && (response.headers.get("Content-Range") !== `bytes 0-0/${source.size}` || response.headers.get("Content-Length") !== "1")) {
        throw new Error("Public HTTP Range probe failed");
      }
      observations.push(response.status);
    } finally { if (response.body) await response.body.cancel(); }
  }
  return observations;
}

export async function verifiedBootstrapDelivery(env: MigrationApplyEnv, execution: ServiceMigrationExecution,
  runtime: BootstrapRuntime): Promise<{ deployment_id: string; worker_version_id: string; assets_verified: number; checks_sha256: string }> {
  await requireMigrationQuiescence(env, execution);
  const plan = await initializedPlan(env, execution);
  const bootstrap = await readMigrationBootstrap(env, execution);
  if (bootstrap?.value.phase !== "verified" || !bootstrap.value.settlement || !bootstrap.value.old_cache_purged_by_execution_id ||
    bootstrap.value.next_asset !== plan.sources.filter((source) => source.key.startsWith("public/") && parsePublicAssetPath(source.key.slice(6))).length) {
    throw new Error("Migration bootstrap has not completed owned cache purge and HTTP verification");
  }
  await requireCandidate(runtime, bootstrap.value.settlement.deployment.worker_version_id);
  await requireServiceMigration(env, execution);
  return { deployment_id: bootstrap.value.settlement.deployment.deployment_id, worker_version_id: runtime.workerVersionId,
    assets_verified: bootstrap.value.next_asset, checks_sha256: bootstrap.value.checks_sha256 };
}

export async function readBootstrapDeliveryWindow(env: MigrationApplyEnv, admission: ServiceAdmission, workerVersionId: string): Promise<string> {
  const migration = admission.migration;
  const candidate = migration?.delivery_candidate;
  if (admission.mode !== "legacy" || admission.state !== "migrating" || admission.invocations.length || !candidate ||
    candidate.worker_version_id !== workerVersionId) throw new Error("No owned migration delivery window exists for this candidate");
  const base = `system/lifecycle-migrations/${migration.migration_id}`;
  const bootstrapObject = await boundedObject(env, `${base}/bootstrap.json`);
  const progressObject = await boundedObject(env, `${base}/progress.json`);
  const quiescenceObject = await boundedObject(env, `${base}/quiescence.json`);
  if (!bootstrapObject || !progressObject || !quiescenceObject) throw new Error("Migration delivery window is missing its durable evidence");
  const bootstrap = migrationBootstrapSchema.parse(await bootstrapObject.json<unknown>());
  const progress = migrationApplyProgressSchema.parse(await progressObject.json<unknown>());
  const quiescence = migrationQuiescenceSchema.parse(await quiescenceObject.json<unknown>());
  const planObject = await boundedObject(env, `${base}/plan.json`, 8_000_000);
  if (!planObject) throw new Error("Migration delivery window has no frozen plan");
  const plan = frozenMigrationPlanSchema.parse(await planObject.json<unknown>());
  if (!["verifying", "verified"].includes(bootstrap.phase) || bootstrap.request.bootstrap_id !== candidate.bootstrap_id ||
    bootstrap.request.plan_sha256 !== candidate.plan_sha256 || bootstrap.settlement?.deployment.deployment_id !== candidate.deployment_id ||
    bootstrap.settlement.deployment.worker_version_id !== workerVersionId || !["runtime", "finished"].includes(progress.phase) ||
    progress.plan_sha256 !== candidate.plan_sha256 || candidate.plan_sha256 !== await bootstrapHash(plan) ||
    progress.next_target !== plan.shows.reduce((count, show) => count + show.episodes.length + 1, 0) ||
    quiescence.bridge_worker_version_id !== bootstrap.request.bridge_worker_version_id) {
    throw new Error("Migration delivery window does not match its initialized and settled bootstrap");
  }
  for (const evidence of [bootstrap.request, progress, quiescence, plan]) {
    if (evidence.service_id !== admission.service_id || evidence.migration_id !== migration.migration_id || evidence.request_sha256 !== migration.request_sha256) {
      throw new Error("Migration delivery evidence belongs to another owner");
    }
  }
  return migration.migration_id;
}
