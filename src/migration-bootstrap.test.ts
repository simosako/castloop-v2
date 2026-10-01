import { describe, expect, test } from "bun:test";
import { frozenMigrationPlanSchema, migrationBootstrapSchema, stringifyLifecycleToml } from "../packages/shared/src/index";
import { runLifecycleMigrationStep } from "./lifecycle-migration-apply";
import { fetchM6Candidate, queueM6Candidate } from "./m6-routes";
import { beginBootstrapDeployment, bootstrapHash, confirmMigrationQuiescence, prepareBootstrapDeployment, readMigrationBootstrap,
  settleBootstrapDeployment, verifiedBootstrapDelivery, verifyBootstrapDeliveryStep } from "./migration-bootstrap";
import { abortUnstartedServiceMigration, acquireServiceMigrationExecution, readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { bootstrapFixture } from "./test-support/bootstrap";

async function prepared() {
  const setup = await bootstrapFixture();
  await setup.run((execution) => prepareBootstrapDeployment(setup.env, execution, setup.bootstrapRequest, setup.bridge));
  return setup;
}

async function settled() {
  const setup = await prepared();
  await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge));
  await setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate));
  return setup;
}

describe("owned migration bootstrap", () => {
  test("initialization stops at runtime without calling a cutover callback or opening admission", async () => {
    const setup = await bootstrapFixture();
    let called = false;
    const result = await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
      verifyCutover: async () => { called = true; return setup.runtime; } }, { initializeOnly: true });
    expect(result).toEqual({ state: "pending", phase: "runtime" });
    expect(called).toBe(false);
    const admission = (await readServiceAdmission(setup.env, "service"))!.value;
    expect(admission.state).toBe("migrating");
    expect(admission.mode).toBe("legacy");
    expect(admission.readiness).toBeUndefined();
  });

  test("old IO settlement must be explicit, frozen and bound to the active bridge/migration", async () => {
    const setup = await bootstrapFixture(false);
    await expect(setup.run((execution) => prepareBootstrapDeployment(setup.env, execution, setup.bootstrapRequest, setup.bridge))).rejects.toThrow("explicit");
    for (const input of [{ ...setup.quiescence, old_rest_puts_settled: false }, { ...setup.quiescence, no_more_legacy_writes: false },
      { ...setup.quiescence, migration_id: crypto.randomUUID() }, { ...setup.quiescence, title: "private" }]) {
      await expect(setup.run((execution) => confirmMigrationQuiescence(setup.env, execution, input, setup.bridge))).rejects.toThrow();
    }
    await setup.run((execution) => confirmMigrationQuiescence(setup.env, execution, setup.quiescence, setup.bridge));
    await setup.run((execution) => confirmMigrationQuiescence(setup.env, execution, setup.quiescence, setup.bridge));
    await expect(setup.run((execution) => confirmMigrationQuiescence(setup.env, execution,
      { ...setup.quiescence, confirmed_at: "2026-10-01T12:00:01Z" }, setup.bridge))).rejects.toThrow("frozen");
    expect(setup.entries.has(setup.bootstrapKey)).toBe(false);
  });

  test("one-time start follows successful bridge purge and never retries an already consumed authorization", async () => {
    const setup = await prepared();
    await expect(setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id,
      { ...setup.bridge, purgeDefaultCache: async () => ({ success: false, errors: [{ code: 1, message: "private error" }] }) }))).rejects.toThrow("purge failed");
    expect(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data).phase).toBe("prepared");
    await expect(setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id,
      { ...setup.bridge, purgeDefaultCache: undefined }))).rejects.toThrow("purge binding");
    expect(await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge)))
      .toEqual({ bootstrap_id: setup.bootstrapRequest.bootstrap_id, start_allowed: true });
    await expect(setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge))).rejects.toThrow("unused");
    expect(setup.purges).toEqual(["bridge-default"]);
  });

  test("successful start CAS with lost response remains deploying; it is not authorization for another PUT", async () => {
    const setup = await prepared();
    const bucket = { ...setup.env.CASTLOOP_BUCKET, put: async (key: string, source: string, options: Parameters<typeof setup.bucket.put>[2]) => {
      const result = await setup.bucket.put(key, source, options);
      if (result && key === setup.bootstrapKey && JSON.parse(source).phase === "deploying") throw new Error("Start response lost");
      return result;
    } };
    const env = { ...setup.env, CASTLOOP_BUCKET: bucket } as never;
    await expect(setup.run((execution) => beginBootstrapDeployment(env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge))).rejects.toThrow("response lost");
    expect(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data).phase).toBe("deploying");
    await expect(setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge))).rejects.toThrow("unused");
    await setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate));
    expect(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data).phase).toBe("verifying");
  });

  test("settlement requires matching service/runtime, explicit no-more-deploys and initialized sources", async () => {
    const setup = await prepared();
    await expect(setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate))).rejects.toThrow("started");
    await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge));
    for (const input of [{ ...setup.settlement, no_more_deploys: false }, { ...setup.settlement, rest_requests_settled: false },
      { ...setup.settlement, deployment: { ...setup.settlement.deployment, worker_name: "another-worker" } },
      { ...setup.settlement, deployment: { ...setup.settlement.deployment, traffic_percentage: 99 } }]) {
      await expect(setup.run((execution) => settleBootstrapDeployment(setup.env, execution, input, setup.candidate))).rejects.toThrow();
    }
    await expect(setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement,
      { ...setup.candidate, workerVersionId: crypto.randomUUID() }))).rejects.toThrow("executing");
    await setup.bucket.put("public/podcasts/daily/feed.xml", "changed after initialization");
    await expect(setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate))).rejects.toThrow("source changed");
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.delivery_candidate).toBeUndefined();
  });

  test("bootstrap cannot regress/change its request; frozen plan forbids automatic legacy rollback", async () => {
    const setup = await prepared();
    await setup.run((execution) => prepareBootstrapDeployment(setup.env, execution, setup.bootstrapRequest, setup.bridge));
    await expect(setup.run((execution) => prepareBootstrapDeployment(setup.env, execution,
      { ...setup.bootstrapRequest, worker_source_sha256: "c".repeat(64) }, setup.bridge))).rejects.toThrow("different");
    await expect(abortUnstartedServiceMigration(setup.env, "service", setup.migrationId)).rejects.toThrow("resumed, not aborted");
    expect(migrationBootstrapSchema.safeParse({ ...JSON.parse(setup.entries.get(setup.bootstrapKey)!.data), phase: "deploying" }).success).toBe(false);
  });
});

describe("migration delivery window and bounded HTTP verification", () => {
  test("initialized frozen state serves only after deployment settlement; mutation consumers stay blocked", async () => {
    const setup = await prepared();
    const request = new Request<unknown, IncomingRequestCfProperties>("https://current.example/podcasts/daily/feed.xml");
    expect((await fetchM6Candidate(request, setup.env, setup.cached)).status).toBe(503);
    await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge));
    expect((await fetchM6Candidate(request, setup.env, setup.cached)).status).toBe(503);
    await setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate));
    const response = await fetchM6Candidate(request, setup.env, setup.cached);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Castloop-Migration-ID")).toBe(setup.migrationId);
    expect(response.headers.get("X-Castloop-Worker-Version")).toBe(setup.candidateVersion);
    expect(await response.text()).toBe("legacy feed");
    await expect(queueM6Candidate({ queue: "test-queue", messages: [{ body: {} }] } as never, setup.env, setup.cached)).rejects.toThrow("readiness");
    expect((await readServiceAdmission(setup.env, "service"))!.value.readiness).toBeUndefined();
  });

  test("HEAD/GET/Range/conditional probes traverse the gateway; results never become full M6 readiness", async () => {
    const setup = await settled();
    expect(await setup.run((execution) => verifyBootstrapDeliveryStep(setup.env, execution, setup.candidate, 1))).toEqual({ state: "pending", next_asset: 1 });
    expect(await setup.run((execution) => verifyBootstrapDeliveryStep(setup.env, execution, setup.candidate, 2))).toEqual({ state: "verified", next_asset: 3 });
    expect(setup.calls).toHaveLength(12);
    for (const method of ["HEAD", "GET"]) expect(setup.calls.some((request) => request.method === method)).toBe(true);
    expect(setup.calls.filter((request) => request.headers.has("Range"))).toHaveLength(3);
    expect(setup.calls.filter((request) => request.headers.has("If-None-Match"))).toHaveLength(3);
    const result = await setup.run((execution) => verifiedBootstrapDelivery(setup.env, execution, setup.candidate));
    expect(result.assets_verified).toBe(3);
    expect(result.checks_sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const field of ["publication_routes_verified", "old_cache_purged", "cutover_verified", "m6_ready", "private"]) expect(JSON.stringify(result)).not.toContain(field);
    expect((await readServiceAdmission(setup.env, "service"))!.value.state).toBe("migrating");
    expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
    expect(setup.purges).toEqual(["bridge-default"]);
  });

  test("forged responses with wrong version/cache policy/size/range cannot advance durable probe progress", async () => {
    for (const failure of ["version", "cache", "etag", "size", "range", "status"] as const) {
      const setup = await settled();
      const runtime = { ...setup.candidate, defaultFetch: async (request: Request) => {
        const response = await setup.candidate.defaultFetch!(request);
        const headers = new Headers(response.headers);
        if (failure === "version") headers.set("X-Castloop-Worker-Version", crypto.randomUUID());
        if (failure === "cache") headers.set("Cache-Control", "public, max-age=300");
        if (failure === "etag") headers.set("ETag", '"foreign"');
        if (failure === "size") headers.set("Content-Length", "1000");
        if (failure === "range" && request.headers.has("Range")) headers.set("Content-Range", "bytes 1-1/10");
        return new Response(response.body, { status: failure === "status" ? 404 : response.status, headers });
      } };
      await expect(setup.run((execution) => verifyBootstrapDeliveryStep(setup.env, execution, runtime, 1))).rejects.toThrow();
      expect(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data).next_asset).toBe(0);
      expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.execution_id).toBeUndefined();
    }
  });

  test("incomplete progress or unrelated runtime fails closed before public cached delivery", async () => {
    for (const failure of ["version", "progress", "quiescence", "bootstrap"] as const) {
      const setup = await settled();
      if (failure === "version") setup.env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
      const base = `system/lifecycle-migrations/${setup.migrationId}`;
      if (failure === "progress") {
        const value = JSON.parse(setup.entries.get(`${base}/progress.json`)!.data);
        await setup.bucket.put(`${base}/progress.json`, JSON.stringify({ ...value, next_target: 0 }));
      }
      if (failure === "quiescence") setup.entries.delete(`${base}/quiescence.json`);
      if (failure === "bootstrap") setup.entries.delete(setup.bootstrapKey);
      const response = await fetchM6Candidate(new Request<unknown, IncomingRequestCfProperties>("https://current.example/podcasts/daily/feed.xml"), setup.env, setup.cached);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("lost HTTP progress response resumes from stored cursor without repeating completed probes", async () => {
    const setup = await settled();
    const env = { ...setup.env, CASTLOOP_BUCKET: { ...setup.env.CASTLOOP_BUCKET,
      put: async (key: string, source: string, options: Parameters<typeof setup.bucket.put>[2]) => {
        const result = await setup.bucket.put(key, source, options);
        if (result && key === setup.bootstrapKey && JSON.parse(source).next_asset === 1) throw new Error("Progress response lost");
        return result;
      } } } as never;
    await expect(setup.run((execution) => verifyBootstrapDeliveryStep(env, execution, setup.candidate, 1))).rejects.toThrow("response lost");
    expect(setup.calls).toHaveLength(4);
    await setup.run((execution) => verifyBootstrapDeliveryStep(setup.env, execution, setup.candidate, 2));
    expect(setup.calls).toHaveLength(12);
  });

  test("delivery-candidate CAS response loss preserves settlement and can retry without reopening deploy", async () => {
    const setup = await prepared();
    await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge));
    const env = { ...setup.env, CASTLOOP_BUCKET: { ...setup.env.CASTLOOP_BUCKET,
      put: async (key: string, source: string, options: Parameters<typeof setup.bucket.put>[2]) => {
        const result = await setup.bucket.put(key, source, options);
        if (result && key === SERVICE_ADMISSION_KEY && JSON.parse(source).migration?.delivery_candidate) throw new Error("Candidate response lost");
        return result;
      } } } as never;
    await expect(setup.run((execution) => settleBootstrapDeployment(env, execution, setup.settlement, setup.candidate))).rejects.toThrow("response lost");
    await setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate));
    expect(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data).phase).toBe("verifying");
  });

  test("execution-token acquisition response loss keeps the token; no bootstrap work can steal it", async () => {
    const setup = await prepared();
    const env = { ...setup.env, CASTLOOP_BUCKET: { ...setup.env.CASTLOOP_BUCKET,
      put: async (key: string, source: string, options: Parameters<typeof setup.bucket.put>[2]) => {
        const result = await setup.bucket.put(key, source, options);
        if (result && key === SERVICE_ADMISSION_KEY && JSON.parse(source).migration?.execution_id) throw new Error("Token response lost");
        return result;
      } } } as never;
    await expect(acquireServiceMigrationExecution(env, "service", setup.migrationId)).rejects.toThrow("response lost");
    await expect(setup.run((execution) => readMigrationBootstrap(setup.env, execution))).rejects.toThrow("still running");
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.execution_id).toBeDefined();
  });

  test("preserved Show/Episode stop states remain 404 even for Range and matching cache validators", async () => {
    for (const target of ["show", "episode"] as const) {
      const setup = await bootstrapFixture(false);
      await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
        lifecycle: target === "show" ? "unpublished" : "active", generation: 3, feed_generation: 4 }));
      await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
        show_id: "daily", episode_id: "first", lifecycle: target === "episode" ? "unpublished" : "active", generation: 8 }));
      await setup.run((execution) => confirmMigrationQuiescence(setup.env, execution, setup.quiescence, setup.bridge));
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects, { initializeOnly: true });
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects, { initializeOnly: true });
      const plan = frozenMigrationPlanSchema.parse(JSON.parse(setup.entries.get(`system/lifecycle-migrations/${setup.migrationId}/plan.json`)!.data));
      const planSha256 = await bootstrapHash(plan);
      await setup.run((execution) => prepareBootstrapDeployment(setup.env, execution, { ...setup.bootstrapRequest,
        plan_sha256: planSha256 }, setup.bridge));
      await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge));
      await setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate));
      expect(await setup.run((execution) => verifyBootstrapDeliveryStep(setup.env, execution, setup.candidate, 3))).toEqual({ state: "verified", next_asset: 3 });
      expect(plan.shows[0]?.value.generation).toBe(3);
      expect(plan.shows[0]?.episodes[0]?.value.generation).toBe(8);
    }
  });
});
