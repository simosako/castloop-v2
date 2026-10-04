import { expect, test } from "bun:test";
import { m6RuntimeReadinessSchema, m6ServiceConfigHash, parseServiceConfig, parseShowMetadata, serviceConfigSchema, serviceUrlChangeRequestSchema,
  serviceManagementBaseUrl, stringifyToml } from "../packages/shared/src/index";
import type { ServiceUrlChangeRequest } from "../packages/shared/src/index";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { beginM6ServiceUpdate } from "./m6-service-update";
import { fetchM6ManagementIntegration } from "./m6-routes";
import { acquireServiceInvocation, pauseServiceAdmission, readServiceAdmission, releaseServiceInvocation,
  requireM6ServiceRuntime, resumeServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { beginServiceUrlChange, completeServiceUrlChange, readServiceUrlChange, stepServiceUrlChange } from "./service-url-change";
import type { ServiceUrlChangeBindings } from "./service-url-change";
import { lifecycleAdminFixture } from "./test-support/lifecycle-admin";

async function fixture(multipleShows = false) {
  const setup = await lifecycleAdminFixture();
  const env = setup.candidateEnv;
  const admission = (await readServiceAdmission(env, setup.config.service_id))!;
  const runtime = m6RuntimeReadinessSchema.parse({ operation_id: crypto.randomUUID(), deployment_id: admission.value.readiness!.deployment_id,
    worker_version_id: setup.versionId, service_config_sha256: await m6ServiceConfigHash(setup.config),
    default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets", cutover_verified: true, publication_routes_verified: true });
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...admission.value, runtime_readiness: runtime }));
  await setup.addEpisode("stopped", "unpublished");
  await setup.addEpisode("removed", "deleted");
  if (multipleShows) {
    for (const [showId, lifecycle] of [["another", "active"], ["draft-show", "draft"], ["stopped-show", "unpublished"], ["deleted-show", "deleted"]]) {
      await setup.bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ schema_version: 2,
        show_id: showId, lifecycle, generation: 0, feed_generation: 0 }));
    }
    const show = { ...parseShowMetadata(setup.text("system/shows/daily/show.toml")), show_id: "another" };
    await setup.bucket.put("system/shows/another/show.toml", stringifyToml(show));
    await setup.bucket.put("public/podcasts/another/cover.jpg", Uint8Array.from([255, 216, 255, 1]));
  }
  const pauseId = crypto.randomUUID();
  const bindings: ServiceUrlChangeBindings = { ...setup.bindings, cachedAssets: setup.cachedAssets };
  const request = async (publicBaseUrl = "https://podcasts.example.com"): Promise<ServiceUrlChangeRequest> => {
    const config = parseServiceConfig(setup.text("system/service.toml"));
    const snapshot = (await readServiceAdmission(env, config.service_id))!;
    const management = serviceManagementBaseUrl(config);
    const target = serviceConfigSchema.parse({ ...config, public_base_url: publicBaseUrl, workers_dev_base_url: management });
    return serviceUrlChangeRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: config.service_id,
      expected_service_generation: snapshot.value.generation, pause_id: pauseId, worker_version_id: setup.versionId,
      service_config_sha256: await m6ServiceConfigHash(config), target_service_config_sha256: await m6ServiceConfigHash(target),
      public_base_url: publicBaseUrl, workers_dev_base_url: management });
  };
  const pause = () => pauseServiceAdmission(env, setup.config.service_id, pauseId, setup.versionId);
  const configure = async (input: ServiceUrlChangeRequest, custom = bindings) => {
    for (let count = 0; count < 10; count++) {
      if ((await stepServiceUrlChange(env, input, custom)).phase === "configured") return;
    }
    throw new Error("URL change did not converge within the fixture budget");
  };
  return { ...setup, env, runtime, bindings, pauseId, request, pause, configure };
}

test("both URL directions regenerate only active feeds, preserve immutable snapshots and finish paused on the same runtime", async () => {
  const setup = await fixture(true);
  await setup.pause();
  const preserved = [...setup.entries].filter(([key]) => key.startsWith("public/episodes/") || key.endsWith(".mp3") ||
    key.startsWith("system/show-publications/") || key.startsWith("system/shows/"))
    .map(([key, value]) => [key, { ...value, bytes: value.bytes.slice() }] as const);
  for (const url of ["https://podcasts.example.com", setup.config.workers_dev_base_url!]) {
    const request = await setup.request(url);
    await beginServiceUrlChange(setup.env, request);
    await setup.configure(request);
    await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId)).rejects.toThrow();
    for (const showId of ["daily", "another"]) {
      const feed = setup.text(`public/podcasts/${showId}/feed.xml`);
      expect(feed).toContain(`${url}/podcasts/${showId}/feed.xml`);
      expect(feed).toContain(`${url}/podcasts/${showId}/cover.jpg`);
      expect(feed).not.toContain("stopped description");
      expect(feed).not.toContain("removed description");
    }
    expect((await completeServiceUrlChange(setup.env, request, setup.bindings)).phase).toBe("complete");
    const admission = (await requireM6ServiceRuntime(setup.env, "service", setup.versionId)).value;
    expect(admission.state).toBe("paused");
    expect(admission.pause_id).toBe(setup.pauseId);
    expect(admission.url_change).toBeUndefined();
    expect(admission.runtime_readiness).toEqual({ ...setup.runtime, service_config_sha256: request.target_service_config_sha256 });
    expect(parseServiceConfig(setup.text("system/service.toml"))).toEqual({ ...setup.config, public_base_url: url });
    expect((await beginServiceUrlChange(setup.env, request)).phase).toBe("complete");
    expect((await completeServiceUrlChange(setup.env, request, setup.bindings)).phase).toBe("complete");
  }
  for (const [key, value] of preserved) expect(setup.entries.get(key)).toEqual(value);
  for (const showId of ["draft-show", "stopped-show", "deleted-show"]) expect(setup.entries.has(`public/podcasts/${showId}/feed.xml`)).toBe(false);
  await resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId);
  expect((await readServiceAdmission(setup.env, "service"))?.value.state).toBe("open");
});

test("URL admission reuses paused generation, invocation and settled Show-owner checks before any feed write", async () => {
  const setup = await fixture();
  await expect(beginServiceUrlChange(setup.env, await setup.request())).rejects.toThrow("paused generation");
  await setup.pause();
  const invocation = await acquireServiceInvocation(setup.env, "service", "m6_recovery");
  await expect(beginServiceUrlChange(setup.env, await setup.request())).rejects.toThrow("paused generation");
  await releaseServiceInvocation(setup.env, invocation);
  const request = await setup.request();
  await expect(beginServiceUrlChange(setup.env, { ...request, target_service_config_sha256: "f".repeat(64) })).rejects.toThrow("may change only");
  await claimShowOperation(setup.env, await setup.operationRequest("show", "unpublish"));
  await expect(beginServiceUrlChange(setup.env, await setup.request())).rejects.toThrow("settled Show owners");
  expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeDefined();
  expect([...setup.entries.keys()].some((key) => key.startsWith("system/service-url-changes/"))).toBe(false);
});

test("an empty existing workspace saves its legacy workers.dev origin only in the owned URL change", async () => {
  const setup = await fixture();
  for (const key of setup.entries.keys()) if (key !== "system/service.toml" && key !== SERVICE_ADMISSION_KEY) setup.entries.delete(key);
  const { workers_dev_base_url: management, ...original } = setup.config;
  const config = { ...original, public_base_url: management! };
  await setup.bucket.put("system/service.toml", stringifyToml(config));
  const admission = (await readServiceAdmission(setup.env, "service"))!;
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...admission.value,
    runtime_readiness: { ...setup.runtime, service_config_sha256: await m6ServiceConfigHash(config) } }));
  await setup.pause();
  const request = await setup.request();
  await beginServiceUrlChange(setup.env, request);
  expect(parseServiceConfig(setup.text("system/service.toml"))).toEqual(config);
  expect((await stepServiceUrlChange(setup.env, request, setup.bindings)).phase).toBe("configured");
  await completeServiceUrlChange(setup.env, request, setup.bindings);
  expect(parseServiceConfig(setup.text("system/service.toml"))).toEqual({ ...config,
    public_base_url: request.public_base_url, workers_dev_base_url: management! });
});

test("purge failure retains the URL owner, old settings and unadvanced progress for an explicit retry", async () => {
  const setup = await fixture();
  await setup.pause();
  const request = await setup.request();
  await beginServiceUrlChange(setup.env, request);
  let calls = 0;
  const bindings = { ...setup.bindings, cachedAssets: { ...setup.bindings.cachedAssets, invalidate: async () => {
    if (++calls === 1) throw new Error("Known purge failure");
  } } };
  await expect(stepServiceUrlChange(setup.env, request, bindings)).rejects.toThrow("Known purge failure");
  expect((await readServiceUrlChange(setup.env, request))?.value.after_show_id).toBeUndefined();
  expect((await readServiceAdmission(setup.env, "service"))?.value.url_change?.execution_id).toBeUndefined();
  expect(parseServiceConfig(setup.text("system/service.toml"))).toEqual(setup.config);
  await expect(completeServiceUrlChange(setup.env, request, bindings)).rejects.toThrow("unfinished");
  await setup.configure(request, bindings);
  await completeServiceUrlChange(setup.env, request, bindings);
  expect(calls).toBe(2);
});

test("settings response loss reconciles the target hash without replaying the settings write", async () => {
  const setup = await fixture();
  await setup.pause();
  const request = await setup.request();
  await beginServiceUrlChange(setup.env, request);
  await stepServiceUrlChange(setup.env, request, setup.bindings);
  let writes = 0;
  const env = { ...setup.env, CASTLOOP_BUCKET: { ...setup.env.CASTLOOP_BUCKET, put: async (...args: Parameters<R2Bucket["put"]>) => {
    const result = await setup.env.CASTLOOP_BUCKET.put(...args);
    if (args[0] === "system/service.toml" && ++writes === 1) throw new Error("Lost settings response");
    return result;
  } } };
  await expect(stepServiceUrlChange(env, request, setup.bindings)).rejects.toThrow("Lost settings response");
  expect((await readServiceUrlChange(env, request))?.value.phase).toBe("feeds");
  expect(parseServiceConfig(setup.text("system/service.toml")).public_base_url).toBe(request.public_base_url);
  expect((await stepServiceUrlChange(env, request, setup.bindings)).phase).toBe("configured");
  await completeServiceUrlChange(env, request, setup.bindings);
  expect(writes).toBe(1);
});

test("a live URL execution blocks consumers, another step, resume and ordinary deploy until its awaited IO settles", async () => {
  const setup = await fixture();
  await setup.pause();
  const request = await setup.request();
  await beginServiceUrlChange(setup.env, request);
  let entered!: () => void;
  let settle!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { settle = resolve; });
  const bindings = { ...setup.bindings, cachedAssets: { ...setup.bindings.cachedAssets, invalidate: async () => { entered(); await held; } } };
  const running = stepServiceUrlChange(setup.env, request, bindings);
  await waiting;
  try {
    const admission = (await readServiceAdmission(setup.env, "service"))!;
    expect(admission.value.url_change?.execution_id).toBeDefined();
    const publicResponse = await fetchM6ManagementIntegration(new Request("https://podcasts.example.com/podcasts/daily/feed.xml") as never,
      setup.env, setup.cachedAssets);
    expect(publicResponse.status).toBe(503);
    for (const kind of ["m6_admin", "m6_consumer", "m6_recovery"] as const) {
      await expect(acquireServiceInvocation(setup.env, "service", kind)).rejects.toThrow("not admitting");
    }
    await expect(stepServiceUrlChange(setup.env, request, setup.bindings)).rejects.toThrow("active or unknown");
    await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId)).rejects.toThrow();
    await expect(beginM6ServiceUpdate(setup.env, { operation_id: crypto.randomUUID(), service_id: "service", pause_id: setup.pauseId,
      expected_service_generation: admission.value.generation, previous_worker_version_id: setup.versionId,
      service_config_sha256: request.service_config_sha256, worker_source_sha256: "a".repeat(64), worker_metadata_sha256: "b".repeat(64) })).rejects.toThrow("exact paused");
  } finally { settle(); await running; }
  expect((await readServiceAdmission(setup.env, "service"))?.value.url_change?.execution_id).toBeUndefined();
  await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId)).rejects.toThrow();
});

test("a residual URL execution token is never cleared by status, absence of a feed or explicit retries", async () => {
  const setup = await fixture();
  await setup.pause();
  const request = await setup.request();
  await beginServiceUrlChange(setup.env, request);
  const admission = (await readServiceAdmission(setup.env, "service"))!;
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...admission.value,
    url_change: { ...admission.value.url_change, execution_id: crypto.randomUUID() } }));
  const before = setup.text(SERVICE_ADMISSION_KEY);
  await readServiceUrlChange(setup.env, request);
  await beginServiceUrlChange(setup.env, request);
  await expect(stepServiceUrlChange(setup.env, request, setup.bindings)).rejects.toThrow("never expire");
  await expect(completeServiceUrlChange(setup.env, request, setup.bindings)).rejects.toThrow("unfinished");
  expect(setup.text(SERVICE_ADMISSION_KEY)).toBe(before);
});
