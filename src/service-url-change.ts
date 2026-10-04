import { m6ServiceConfigHash, serviceConfigSchema, serviceManagementBaseUrl,
  serviceUrlChangeProgressSchema, serviceUrlChangeRequestSchema, stringifyToml } from "../packages/shared/src/index";
import type { ServiceUrlChangeProgress, ServiceUrlChangeRequest } from "../packages/shared/src/index";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { readActiveShowFeedInputs, readPublishedFeedSource, writePublishedFeed } from "./lifecycle-feed";
import { requireM6ManagementRuntime } from "./m6-management";
import { readM6ServiceConfiguration } from "./m6-runtime-readiness";
import { compareAndSetServiceAdmission, readServiceAdmission, requireM6ServiceRuntime } from "./service-admission";
import type { ServiceAdmissionSnapshot } from "./service-admission";
import { readSettledShowControls } from "./service-quiescence";

export type ServiceUrlChangeEnv = LifecycleFeedEnv & { CASTLOOP_VERSION_METADATA: Pick<WorkerVersionMetadata, "id"> };
export type ServiceUrlChangeBindings = M6DeliveryGateBindings & { cachedAssets: M6DeliveryGateBindings["cachedAssets"] & {
  invalidate: (target: { showId: string }) => Promise<void>;
} };

function recordKey(request: ServiceUrlChangeRequest): string {
  return `system/service-url-changes/${request.operation_id}/progress.json`;
}

async function requestHash(request: ServiceUrlChangeRequest): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readServiceUrlChange(env: ServiceUrlChangeEnv, input: ServiceUrlChangeRequest):
  Promise<{ value: ServiceUrlChangeProgress; etag: string } | null> {
  const request = serviceUrlChangeRequestSchema.parse(input);
  const object = await env.CASTLOOP_BUCKET.get(recordKey(request));
  if (!object) return null;
  if (object.size < 1 || object.size > 16384) throw new Error("URL change record is empty or oversized");
  const value = serviceUrlChangeProgressSchema.parse(await object.json<unknown>());
  if (JSON.stringify(value.request) !== JSON.stringify(request)) throw new Error("URL change has another permanent frozen request");
  return { value, etag: object.etag };
}

async function configuration(env: ServiceUrlChangeEnv, request: ServiceUrlChangeRequest) {
  const current = await readM6ServiceConfiguration(env);
  const hash = await m6ServiceConfigHash(current.config);
  if (current.config.service_id !== request.service_id || serviceManagementBaseUrl(current.config) !== request.workers_dev_base_url ||
    ![request.service_config_sha256, request.target_service_config_sha256].includes(hash)) {
    throw new Error("URL change differs from its frozen service configuration or management origin");
  }
  const target = serviceConfigSchema.parse({ ...current.config, public_base_url: request.public_base_url,
    workers_dev_base_url: request.workers_dev_base_url });
  if (new TextEncoder().encode(stringifyToml(target)).length > 16384) throw new Error("URL change configuration exceeds its record budget");
  if (await m6ServiceConfigHash(target) !== request.target_service_config_sha256) throw new Error("URL change may change only its canonical URL and saved management origin");
  return { ...current, hash, target };
}

async function requireOwner(env: ServiceUrlChangeEnv, request: ServiceUrlChangeRequest, hash: string,
  executionId?: string): Promise<ServiceAdmissionSnapshot> {
  const snapshot = await readServiceAdmission(env, request.service_id);
  const owner = snapshot?.value.url_change;
  if (!snapshot || snapshot.value.mode !== "m6" || snapshot.value.state !== "paused" || snapshot.value.pause_id !== request.pause_id ||
    snapshot.value.invocations.length || owner?.operation_id !== request.operation_id || owner.request_sha256 !== hash ||
    executionId !== undefined && owner.execution_id !== executionId ||
    (snapshot.value.runtime_readiness ?? snapshot.value.readiness)?.worker_version_id !== request.worker_version_id ||
    env.CASTLOOP_VERSION_METADATA.id !== request.worker_version_id) {
    throw new Error("URL change requires its exact paused owner, executing Worker and execution token");
  }
  return snapshot;
}

export async function beginServiceUrlChange(env: ServiceUrlChangeEnv, input: ServiceUrlChangeRequest): Promise<ServiceUrlChangeProgress> {
  const request = serviceUrlChangeRequestSchema.parse(input);
  const hash = await requestHash(request);
  const existing = await readServiceUrlChange(env, request);
  const admission = await readServiceAdmission(env, request.service_id);
  if (admission?.value.url_change) {
    await requireOwner(env, request, hash);
    if (!existing) throw new Error("URL change lost its permanent record");
    return existing.value;
  }
  const current = await configuration(env, request);
  const snapshot = await requireM6ServiceRuntime(env, request.service_id, env.CASTLOOP_VERSION_METADATA.id);
  if (existing?.value.phase === "complete" && current.hash === request.target_service_config_sha256 &&
    snapshot.readiness.worker_version_id === request.worker_version_id) return existing.value;
  if (snapshot.value.state !== "paused" || snapshot.value.pause_id !== request.pause_id || snapshot.value.invocations.length ||
    snapshot.value.generation !== request.expected_service_generation || current.hash !== request.service_config_sha256 ||
    snapshot.readiness.worker_version_id !== request.worker_version_id ||
    snapshot.value.runtime_readiness && snapshot.value.runtime_readiness.service_config_sha256 !== current.hash ||
    new URL(current.config.public_base_url).origin === new URL(request.public_base_url).origin) {
    throw new Error("URL change requires its original configuration, exact paused generation and no live invocations");
  }
  await readSettledShowControls(env);
  if ((await readM6ServiceConfiguration(env)).etag !== current.etag) throw new Error("Service configuration changed before URL change admission");
  const progress = existing?.value ?? serviceUrlChangeProgressSchema.parse({ schema_version: 1, request, phase: "feeds" });
  if (progress.phase !== "feeds" || progress.after_show_id) throw new Error("An advanced URL change cannot be claimed as a new operation");
  const source = JSON.stringify(progress);
  if (new TextEncoder().encode(source).length > 16384) throw new Error("URL change exceeds its record budget");
  if (!existing && !await env.CASTLOOP_BUCKET.put(recordKey(request), source, { onlyIf: new Headers({ "If-None-Match": "*" }) })) {
    throw new Error("URL change record conflicted; preserve its permanent identity");
  }
  if (!await compareAndSetServiceAdmission(env, snapshot, { ...snapshot.value, url_change: { operation_id: request.operation_id, request_sha256: hash } })) {
    throw new Error("Service admission changed before URL change; no feed or settings were changed");
  }
  return progress;
}

async function withExecution<T>(env: ServiceUrlChangeEnv, request: ServiceUrlChangeRequest, bindings: ServiceUrlChangeBindings,
  callback: (guard: () => Promise<ServiceAdmissionSnapshot>) => Promise<T>): Promise<T> {
  const hash = await requestHash(request);
  const snapshot = await requireOwner(env, request, hash);
  if (snapshot.value.url_change!.execution_id) throw new Error("URL change has an active or unknown execution; never expire it");
  const executionId = crypto.randomUUID();
  if (!await compareAndSetServiceAdmission(env, snapshot, { ...snapshot.value, url_change: { ...snapshot.value.url_change!, execution_id: executionId } })) {
    throw new Error("URL change execution conflicted; retry explicitly");
  }
  const guard = async () => {
    const owned = await requireOwner(env, request, hash, executionId);
    await requireM6ManagementRuntime(bindings, (owned.value.runtime_readiness ?? owned.value.readiness)!);
    return requireOwner(env, request, hash, executionId);
  };
  try {
    await guard();
    return await callback(guard);
  } finally {
    const current = await readServiceAdmission(env, request.service_id);
    if (current?.value.url_change) {
      const owned = await requireOwner(env, request, hash, executionId);
      const { execution_id: _execution, ...owner } = owned.value.url_change!;
      if (!await compareAndSetServiceAdmission(env, owned, { ...owned.value, url_change: owner })) {
        throw new Error("URL change execution return conflicted; retain its token");
      }
    }
  }
}

async function saveProgress(env: ServiceUrlChangeEnv, previous: NonNullable<Awaited<ReturnType<typeof readServiceUrlChange>>>,
  value: ServiceUrlChangeProgress): Promise<void> {
  const source = JSON.stringify(serviceUrlChangeProgressSchema.parse(value));
  if (new TextEncoder().encode(source).length > 16384) throw new Error("URL change exceeds its record budget");
  if (!await env.CASTLOOP_BUCKET.put(recordKey(value.request), source,
    { onlyIf: { etagMatches: previous.etag } })) throw new Error("URL change progress changed; retain its owner");
}

export async function stepServiceUrlChange(env: ServiceUrlChangeEnv, input: ServiceUrlChangeRequest,
  bindings: ServiceUrlChangeBindings): Promise<ServiceUrlChangeProgress> {
  const request = serviceUrlChangeRequestSchema.parse(input);
  return withExecution(env, request, bindings, async (guard) => {
    const progress = await readServiceUrlChange(env, request);
    if (!progress) throw new Error("URL change lost its permanent record");
    const current = await configuration(env, request);
    if (progress.value.phase !== "feeds") return progress.value;
    const controls = await readSettledShowControls(env);
    const next = controls.find((control) => !progress.value.after_show_id || control.value.show_id > progress.value.after_show_id);
    if (next) {
      if (current.hash !== request.service_config_sha256) throw new Error("URL change settings advanced before all feeds were processed");
      const showId = next.value.show_id;
      const inputs = await readActiveShowFeedInputs(env, showId);
      if (inputs.writeFeed) {
        const source = await readPublishedFeedSource(env, showId);
        await writePublishedFeed(env, source, inputs.episodes, async () => { await guard(); }, request.public_base_url);
        await guard();
        await bindings.cachedAssets.invalidate({ showId });
        await guard();
      }
      const value = { ...progress.value, after_show_id: showId };
      await saveProgress(env, progress, value);
      return value;
    }
    await guard();
    if (current.hash !== request.target_service_config_sha256 &&
      !await env.CASTLOOP_BUCKET.put("system/service.toml", stringifyToml(current.target), { onlyIf: { etagMatches: current.etag } })) {
      throw new Error("URL change configuration write conflicted");
    }
    if ((await configuration(env, request)).hash !== request.target_service_config_sha256) throw new Error("URL change configuration did not converge");
    await guard();
    const value = { ...progress.value, phase: "configured" as const };
    await saveProgress(env, progress, value);
    return value;
  });
}

export async function completeServiceUrlChange(env: ServiceUrlChangeEnv, input: ServiceUrlChangeRequest,
  bindings: ServiceUrlChangeBindings): Promise<ServiceUrlChangeProgress> {
  const request = serviceUrlChangeRequestSchema.parse(input);
  const progress = await readServiceUrlChange(env, request);
  if (!progress || progress.value.phase === "feeds") throw new Error("URL change feeds, purge and settings are unfinished");
  if ((await configuration(env, request)).hash !== request.target_service_config_sha256) throw new Error("URL change has not reached its target configuration");
  const admission = await readServiceAdmission(env, request.service_id);
  if (!admission?.value.url_change) {
    const ready = await requireM6ServiceRuntime(env, request.service_id, request.worker_version_id);
    if (env.CASTLOOP_VERSION_METADATA.id !== request.worker_version_id || progress.value.phase !== "complete" ||
      ready.value.runtime_readiness && ready.value.runtime_readiness.service_config_sha256 !== request.target_service_config_sha256) {
      throw new Error("URL change has no matching completed owner or readiness");
    }
    return progress.value;
  }
  return withExecution(env, request, bindings, async (guard) => {
    const value = { ...progress.value, phase: "complete" as const };
    await guard();
    if (progress.value.phase !== "complete") await saveProgress(env, progress, value);
    if ((await configuration(env, request)).hash !== request.target_service_config_sha256) throw new Error("URL change configuration changed before completion");
    const snapshot = await guard();
    const { url_change: _owner, ...settled } = snapshot.value;
    if (settled.runtime_readiness) settled.runtime_readiness = { ...settled.runtime_readiness, service_config_sha256: request.target_service_config_sha256 };
    if (!await compareAndSetServiceAdmission(env, snapshot, settled)) throw new Error("URL change completion conflicted; remain paused with retained ownership");
    return value;
  });
}
