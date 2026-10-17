import { expect, test } from "bun:test";
import { m6SetupRecordKey, parseShowControl, serviceAdmissionSchema, stringifyLifecycleToml } from "../packages/shared/src/index";
import { beginM6ServiceUpdate, completeM6ServiceUpdate } from "./m6-service-update";
import { acquireServiceInvocation, readServiceAdmission, releaseServiceInvocation, requireM6ServiceRuntime,
  resumeServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { m6UpdateFixture as fixture } from "./test-support/m6-update";
import { publicDeliveryMetadata } from "./public-delivery-records";
import { readPublicDeliverySnapshot, readPublicServiceDelivery } from "./public-delivery-state";

test("compatible update closes IO, verifies the new runtime, preserves every content record and requires explicit resume", async () => {
  const setup = await fixture();
  await setup.bucket.put("system/show-publications/daily.json", JSON.stringify(parseShowControl({ schema_version: 2,
    show_id: "daily", lifecycle: "active", generation: 5, feed_generation: 3 })));
  for (const [episodeId, lifecycle] of [["first", "active"], ["stopped", "unpublished"], ["deleted", "deleted"]] as const) {
    await setup.bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml({ schema_version: 1,
      show_id: "daily", episode_id: episodeId, lifecycle, generation: 7 }));
  }
  for (const key of ["public/podcasts/daily/feed.xml", "public/podcasts/daily/episodes/first/revision.mp3",
    "public/episodes/daily/first/revisions/revision.toml", "staging/retained/audio.mp3", "system/jobs/retained/status.toml"]) {
    await setup.bucket.put(key, "retained-content");
  }
  const content = new Map([...setup.entries].filter(([key]) => key !== SERVICE_ADMISSION_KEY));
  await beginM6ServiceUpdate(setup.env, setup.request);
  const before = [...setup.writes];
  await beginM6ServiceUpdate(setup.env, setup.request);
  expect(setup.writes).toEqual(before);
  for (const kind of ["m6_admin", "m6_consumer", "m6_recovery", "legacy_admin"] as const) {
    await expect(acquireServiceInvocation(setup.env, setup.config.service_id, kind)).rejects.toThrow("not admitting");
  }
  await expect(resumeServiceAdmission(setup.env, setup.config.service_id, setup.request.pause_id)).rejects.toThrow("pause owner");
  await expect(requireM6ServiceRuntime(setup.env, setup.config.service_id, setup.versionId)).rejects.toThrow("readiness");
  expect(await completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, setup.updateChecks)).toEqual(setup.newReadiness);
  const completed = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  expect(completed.state).toBe("paused");
  expect(completed.update).toBeUndefined();
  for (const [key, value] of content) {
    const current = setup.entries.get(key)!;
    if (key === "system/service.toml" || key.startsWith("system/show-publications/") || key.startsWith("system/episode-lifecycle/")) {
      expect(current.bytes).toEqual(value.bytes);
      expect(current.size).toBe(value.size);
      expect(current.customMetadata).toEqual(publicDeliveryMetadata(key, new TextDecoder().decode(value.bytes)));
    } else expect(current).toEqual(value);
  }
  expect([...setup.entries.keys()].some((key) => key.startsWith("system/lifecycle-migrations/"))).toBe(false);
  await expect(readPublicServiceDelivery(setup.newEnv, setup.newTarget.worker_version_id, setup.config.dlq_name)).rejects.toThrow("open runtime");
  expect(await readPublicDeliverySnapshot(setup.newEnv, "daily", "first")).toEqual({ visibility: "public", showId: "daily",
    showGeneration: 5, feedGeneration: 3, episodeId: "first", episodeGeneration: 7 });
  expect(await readPublicDeliverySnapshot(setup.newEnv, "daily", "stopped")).toEqual({ visibility: "not_found" });
  expect(await readPublicDeliverySnapshot(setup.newEnv, "daily", "deleted")).toEqual({ visibility: "gone" });
  await completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, {
    inspectDeployment: async () => { throw new Error("No duplicate verification"); }, verifyRuntime: async () => { throw new Error("No reactivation"); } });
  await expect(requireM6ServiceRuntime(setup.env, setup.config.service_id, setup.versionId)).rejects.toThrow("Worker version");
  await resumeServiceAdmission(setup.newEnv, setup.config.service_id, setup.request.pause_id);
  expect(await readPublicServiceDelivery(setup.newEnv, setup.newTarget.worker_version_id, setup.config.dlq_name)).toEqual({ serviceId: "service", mode: "m6" });
  expect((await requireM6ServiceRuntime(setup.newEnv, setup.config.service_id, setup.newTarget.worker_version_id)).readiness).toEqual(setup.newReadiness);
});

test("projection preparation awaits its owned IO and a settled failure retains the exact update without opening delivery", async () => {
  const setup = await fixture();
  const key = "system/show-publications/daily.json";
  const source = JSON.stringify({ schema_version: 2, show_id: "daily", lifecycle: "active", generation: 5, feed_generation: 3 });
  await setup.bucket.put(key, source);
  await beginM6ServiceUpdate(setup.env, setup.request);
  const started = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const pendingEnv = { ...setup.newEnv, CASTLOOP_BUCKET: { ...setup.bucket,
    async put(...args: Parameters<typeof setup.bucket.put>) {
      if (args[0] === key) {
        started.resolve();
        await settled.promise;
        await setup.bucket.put(...args);
        throw new Error("Delivery preparation response lost");
      }
      return await setup.bucket.put(...args);
    },
  } } as never;
  const completion = (async () => {
    try { await completeM6ServiceUpdate(pendingEnv, setup.request, setup.newTarget, setup.updateChecks); return null; }
    catch (error) { return error; }
  })();
  await started.promise;
  try {
    const held = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
    expect(held.state).toBe("updating");
    expect(held.update!.target).toEqual(setup.newTarget);
    await expect(resumeServiceAdmission(setup.newEnv, setup.config.service_id, setup.request.pause_id)).rejects.toThrow("pause owner");
    await expect(readPublicServiceDelivery(setup.newEnv, setup.newTarget.worker_version_id, setup.config.dlq_name)).rejects.toThrow("open runtime");
  } finally { settled.resolve(); }
  expect(String(await completion)).toContain("response lost");
  expect(setup.text(key)).toBe(source);
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("updating");
  await completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, setup.updateChecks);
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
});

test("compatible updates retain unknown invocation/upload/publication owners and refuse incomplete registration", async () => {
  for (const state of ["token", "uploading", "reserved", "processing", "registration", "deleting", "runtime-id"] as const) {
    const setup = await fixture();
    if (state === "token") await acquireServiceInvocation(setup.env, setup.config.service_id, "m6_consumer");
    else if (state === "runtime-id") await setup.bucket.put(m6SetupRecordKey(setup.request.operation_id), "retained-runtime-check");
    else await setup.bucket.put("system/show-publications/daily.json", JSON.stringify(parseShowControl({ schema_version: 2,
      show_id: "daily", lifecycle: state === "deleting" ? "deleting" : "active", generation: 0, feed_generation: 0,
      ...(state === "registration" ? { reservation_id: crypto.randomUUID() } : state === "deleting" ? {} : { owner: { job_id: crypto.randomUUID(), kind: "show",
        action: state === "uploading" ? "stage" : "publish", state, request_sha256: "a".repeat(64) } }) })));
    const before = new Map(setup.entries);
    await expect(beginM6ServiceUpdate(setup.env, setup.request)).rejects.toThrow();
    expect(setup.entries).toEqual(before);
  }
});

test("truncated control inspection refuses admission and a failed completion CAS preserves the current owner", async () => {
  const setup = await fixture();
  const before = [...setup.writes];
  await expect(beginM6ServiceUpdate({ ...setup.env, CASTLOOP_BUCKET: { ...setup.bucket,
    list: async () => ({ objects: [], truncated: true, cursor: "next" }) } } as never, setup.request)).rejects.toThrow("inspection budget");
  expect(setup.writes).toEqual(before);
  await beginM6ServiceUpdate(setup.env, setup.request);
  await expect(completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, { ...setup.updateChecks,
    verifyRuntime: async () => {
      const current = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
      await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...current, generation: current.generation + 1 }));
      return setup.newReadiness;
    } })).rejects.toThrow("admission changed");
  const current = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  expect(current.state).toBe("updating");
  expect(current.update!.target).toEqual(setup.newTarget);
  expect(current.runtime_readiness).toEqual(setup.readiness);
});

test("late draining consumers and competing update requests cannot pass the atomic maintenance boundary", async () => {
  const setup = await fixture();
  const results = await Promise.allSettled([beginM6ServiceUpdate(setup.env, setup.request),
    beginM6ServiceUpdate(setup.env, { ...setup.request, operation_id: crypto.randomUUID() })]);
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
  const late = await fixture();
  const originalList = late.bucket.list.bind(late.bucket);
  const env = { ...late.env, CASTLOOP_BUCKET: { ...late.bucket, list: async (options: R2ListOptions) => {
    const token = await acquireServiceInvocation(late.env, late.config.service_id, "m6_consumer");
    await releaseServiceInvocation(late.env, token);
    return originalList({ ...options, prefix: options.prefix ?? "" });
  } } };
  await expect(beginM6ServiceUpdate(env as never, late.request)).rejects.toThrow("admission changed");
  expect((await readServiceAdmission(late.env, late.config.service_id))!.value.state).toBe("paused");
});

test("failed verification pins the exact new target and never reinstates old readiness or resumes the service", async () => {
  const setup = await fixture();
  await beginM6ServiceUpdate(setup.env, setup.request);
  await expect(completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, { ...setup.updateChecks,
    verifyRuntime: async () => { throw new Error("Verification response lost"); } })).rejects.toThrow("lost");
  const pending = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  expect(pending.state).toBe("updating");
  expect(pending.update!.target).toEqual(setup.newTarget);
  expect(pending.runtime_readiness).toEqual(setup.readiness);
  await expect(completeM6ServiceUpdate(setup.newEnv, { ...setup.request, worker_source_sha256: "c".repeat(64) }, setup.newTarget, setup.updateChecks)).rejects.toThrow("frozen request");
  await expect(completeM6ServiceUpdate(setup.newEnv, setup.request, { ...setup.newTarget, deployment_id: crypto.randomUUID() }, setup.updateChecks)).rejects.toThrow("another deployment");
  expect(await completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, setup.updateChecks)).toEqual(setup.newReadiness);
});

test("ordinary updates retain legacy migration audit evidence without rerunning any data conversion", async () => {
  const setup = await fixture();
  const admission = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  const legacyReadiness = { migration_id: crypto.randomUUID(), plan_sha256: "a".repeat(64), deployment_id: setup.target.deployment_id,
    worker_version_id: setup.versionId, completed_execution_id: crypto.randomUUID(), default_cache_disabled: true,
    cached_entrypoint: "CachedPublicAssets", old_cache_purged: true, cutover_verified: true, old_io_quiesced: true, publication_routes_verified: true } as const;
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify(serviceAdmissionSchema.parse({ ...admission, runtime_readiness: undefined, readiness: legacyReadiness })));
  await beginM6ServiceUpdate(setup.env, setup.request);
  await completeM6ServiceUpdate(setup.newEnv, setup.request, setup.newTarget, setup.updateChecks);
  const completed = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  expect(completed.readiness).toEqual(legacyReadiness);
  expect(completed.runtime_readiness).toEqual(setup.newReadiness);
});
