import { describe, expect, test } from "bun:test";
import { parseJobStatus, parseShowControl, stagePayloadKey, stageUploadProgressSchema, stagingAdminRequestSchema, stagingAdminResponseSchema } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import { fetchM6Candidate } from "./m6-routes";
import { acquireServiceInvocation, pauseServiceAdmission, readServiceAdmission, releaseServiceInvocation, SERVICE_ADMISSION_KEY } from "./service-admission";
import { handleM6StagingAdmin } from "./staging-admin";
import { publicationTestDigest } from "./test-support/episode-publication";
import { stagingAdminFixture } from "./test-support/staging-admin";

describe("unreleased M6 staging management boundary", () => {
  test("Show/metadata/audio staging use registered admission, one PUT start and explicit verified finish without publishing", async () => {
    for (const kind of ["show", "episode_metadata", "audio"] as const) {
      const setup = await stagingAdminFixture(kind);
      const publicBefore = [...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"));
      const claim = await setup.success(setup.input("claim", { upload: setup.upload }));
      expect(claim.result).toBe("claimed");
      expect(claim.operation).toEqual(setup.operation);
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("uploading");
      const begin = await setup.success(setup.input("begin", { operation: setup.operation }));
      expect(begin.result).toBe("started");
      if (begin.result !== "started") throw new Error("Expected staging PUT locations");
      expect(begin.payloads).toEqual(setup.upload.payloads.map((payload) => ({ key: stagePayloadKey(setup.upload, payload.asset),
        length: payload.length_bytes, sha256: payload.sha256 })));
      expect((await setup.call(setup.input("begin", { operation: setup.operation }))).status).toBe(409);
      await setup.putPayloads();
      expect((await setup.call(setup.input("finish", { operation: setup.operation, outcome: "staged" }))).status).toBe(409);
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeDefined();
      const settle = await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
      expect(settle.result).toBe("settled");
      expect((await setup.success(setup.input("finish", { operation: setup.operation, outcome: "staged" }))).result).toBe("staged");
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readShowControl(setup.env, "daily"))?.value.last_finished_upload?.outcome).toBe("staged");
      expect(parseJobStatus(setup.text(`system/jobs/${setup.operation.operation_id}/status.toml`)).state).toBe("completed");
      expect(setup.entries.has(`${stagePayloadKey(setup.upload, setup.contents[0]!.asset).replace(/[^/]+$/, "")}commit.json`)).toBe(false);
      expect([...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"))).toEqual(publicBefore);
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    }
  });

  test("authentication, strict input and method validation precede body reads or any R2 mutation", async () => {
    const setup = await stagingAdminFixture();
    const before = setup.writes.length;
    const unauthorized = setup.http(setup.input("claim", { upload: setup.upload }), "wrong");
    const response = await handleM6StagingAdmin(unauthorized, setup.env, setup.bindings);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(unauthorized.bodyUsed).toBe(false);
    expect((await handleM6StagingAdmin(setup.http({}, "private-secret", "GET"), setup.env, setup.bindings))?.status).toBe(405);
    expect(await handleM6StagingAdmin(new Request("https://current.example/admin/other"), setup.env, setup.bindings)).toBeNull();
    for (const input of [{ ...setup.input("claim", { upload: setup.upload }), title: "private" },
      { ...setup.input("claim", { upload: setup.upload }), service_id: "foreign" },
      { ...setup.input("claim", { upload: setup.upload }), upload: { ...setup.upload, secret: "private" } },
      { ...setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }), no_more_puts: false },
      setup.input("begin", { operation: { ...setup.operation, show_id: "../daily" } })]) {
      const result = await setup.call(input);
      expect(result.status).toBe(400);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(setup.writes).toHaveLength(before);
  });

  test("oversized streaming body is rejected without a token or payload buffering", async () => {
    const setup = await stagingAdminFixture();
    const before = setup.writes.length;
    let cancelled = false;
    const request = new Request("https://current.example/admin/staging", { method: "POST", headers: { "X-Castloop-Key": "private-secret" },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } }) });
    const result = await handleM6StagingAdmin(request, setup.env, setup.bindings);
    expect(result?.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(setup.writes).toHaveLength(before);
  });

  test("missing/legacy/migrating admission and mismatched executing/cache-owner versions refuse staging", async () => {
    for (const change of ["missing", "legacy", "migrating", "version", "cache-owner"] as const) {
      const setup = await stagingAdminFixture();
      const showBefore = setup.text("system/show-publications/daily.json");
      if (change === "missing") setup.entries.delete(SERVICE_ADMISSION_KEY);
      if (change === "legacy" || change === "migrating") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({
        schema_version: 1, service_id: "service", generation: 0, mode: "legacy", state: change === "legacy" ? "open" : "migrating", invocations: [],
        ...(change === "migrating" ? { pause_id: crypto.randomUUID(), migration: { migration_id: crypto.randomUUID(), request_sha256: "a".repeat(64) } } : {}),
      }));
      if (change === "version") setup.bindings.versionMetadata.id = crypto.randomUUID();
      if (change === "cache-owner") setup.bindings.cachedAssets.describeRuntime = async () => ({ schema_version: 1,
        protocol: "m6-cached-assets-v1", entrypoint: "CachedPublicAssets", worker_version_id: crypto.randomUUID(), purge_api_available: true });
      const result = await setup.call(setup.input("claim", { upload: setup.upload }));
      expect(result.status).toBe(409);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(setup.text("system/show-publications/daily.json")).toBe(showBefore);
      expect(setup.entries.has(`system/jobs/${setup.upload.operation_id}/upload.json`)).toBe(false);
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations ?? []).toEqual([]);
    }
  });

  test("pause prevents new claim/PUT start but permits already-held upload settlement and verification", async () => {
    const setup = await stagingAdminFixture();
    await setup.success(setup.input("claim", { upload: setup.upload }));
    await setup.success(setup.input("begin", { operation: setup.operation }));
    await setup.putPayloads();
    const pauseId = crypto.randomUUID();
    await pauseServiceAdmission(setup.env, "service", pauseId);
    expect((await setup.call(setup.input("claim", { upload: { ...setup.upload, operation_id: crypto.randomUUID() } }))).status).toBe(409);
    expect((await setup.call(setup.input("begin", { operation: setup.operation }))).status).toBe(409);
    await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
    await setup.success(setup.input("finish", { operation: setup.operation, outcome: "staged" }));
    const service = (await readServiceAdmission(setup.env, "service"))!.value;
    expect(service.state).toBe("paused");
    expect(service.pause_id).toBe(pauseId);
    expect(service.invocations).toEqual([]);
  });

  test("abort requires explicit settlement and preserves payloads and minimal operational records", async () => {
    const setup = await stagingAdminFixture("audio");
    await setup.success(setup.input("claim", { upload: setup.upload }));
    await setup.success(setup.input("begin", { operation: setup.operation }));
    await setup.putPayloads();
    expect((await setup.call(setup.input("finish", { operation: setup.operation, outcome: "aborted" }))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("uploading");
    await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
    expect((await setup.success(setup.input("finish", { operation: setup.operation, outcome: "aborted" }))).result).toBe("aborted");
    expect(setup.entries.has(stagePayloadKey(setup.upload, "audio"))).toBe(true);
    const progress = setup.text(`system/jobs/${setup.upload.operation_id}/upload-progress.json`);
    expect(progress).toContain('"outcome":"aborted"');
    expect(progress).not.toContain("Private");
    expect(progress).not.toContain("private-secret");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("settling a ready upload permits explicit abort without ever granting PUT permission", async () => {
    const setup = await stagingAdminFixture();
    await setup.success(setup.input("claim", { upload: setup.upload }));
    await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
    expect((await setup.call(setup.input("begin", { operation: setup.operation }))).status).toBe(409);
    expect((await setup.success(setup.input("finish", { operation: setup.operation, outcome: "aborted" }))).result).toBe("aborted");
  });

  test("while verification streams are live, service and Show tokens remain held despite pause", async () => {
    const setup = await stagingAdminFixture("audio");
    await setup.success(setup.input("claim", { upload: setup.upload }));
    await setup.success(setup.input("begin", { operation: setup.operation }));
    await setup.putPayloads();
    await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const pending = handleM6StagingAdmin(setup.http(setup.input("finish", { operation: setup.operation, outcome: "staged" })), setup.env, setup.bindings, {
      digest: async (body, length) => { started.resolve(); await ended.promise; return publicationTestDigest(body, length); },
    });
    await started.promise;
    const held = (await readServiceAdmission(setup.env, "service"))!.value.invocations;
    expect(held).toHaveLength(1);
    expect(held[0]?.kind).toBe("m6_recovery");
    const verificationId = (await readShowControl(setup.env, "daily"))?.value.owner?.verification_id;
    expect(verificationId).toBeDefined();
    await pauseServiceAdmission(setup.env, "service", crypto.randomUUID());
    expect((await setup.call(setup.input("finish", { operation: setup.operation, outcome: "aborted" }))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.verification_id).toBe(verificationId);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual(held);
    ended.resolve();
    expect((await pending)?.status).toBe(200);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("corrupt uploaded payload retains recoverable owner and allowlisted diagnostics, not arbitrary exceptions", async () => {
    const setup = await stagingAdminFixture("audio");
    await setup.success(setup.input("claim", { upload: setup.upload }));
    await setup.success(setup.input("begin", { operation: setup.operation }));
    await setup.bucket.put(stagePayloadKey(setup.upload, "audio"), "bad");
    await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
    const result = await setup.call(setup.input("finish", { operation: setup.operation, outcome: "staged" }));
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("size");
    const owner = (await readShowControl(setup.env, "daily"))?.value.owner;
    expect(owner?.state).toBe("uploading");
    expect(owner?.verification_id).toBeUndefined();
    expect(setup.text(`system/jobs/${setup.upload.operation_id}/upload-progress.json`)).toContain('"reason_code":"validation_failed"');
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    await setup.success(setup.input("finish", { operation: setup.operation, outcome: "aborted" }));
  });

  test("generation mismatch, existing publication and foreign operation do not release or steal ownership", async () => {
    const setup = await stagingAdminFixture();
    await setup.success(setup.input("claim", { upload: setup.upload }));
    const owner = (await readShowControl(setup.env, "daily"))?.value.owner;
    for (const operation of [{ ...setup.operation, operation_id: crypto.randomUUID() }, { ...setup.operation, show_generation: setup.operation.show_generation + 1 }]) {
      expect((await setup.call(setup.input("begin", { operation }))).status).toBe(409);
    }
    expect((await setup.call(setup.input("claim", { upload: { ...setup.upload, operation_id: crypto.randomUUID() } }))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toEqual(owner);
  });

  test("one-time begin response loss never grants PUT permission again even when no payload exists", async () => {
    const setup = await stagingAdminFixture();
    await setup.success(setup.input("claim", { upload: setup.upload }));
    const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
    setup.env.CASTLOOP_BUCKET.put = (async (key: string, value: string, options?: R2PutOptions) => {
      const written = await original(key, value, options);
      if (key.endsWith("upload-progress.json") && stageUploadProgressSchema.parse(JSON.parse(value)).phase === "uploading") throw new Error("Begin outcome lost");
      return written;
    }) as typeof setup.env.CASTLOOP_BUCKET.put;
    expect((await setup.call(setup.input("begin", { operation: setup.operation }))).status).toBe(409);
    setup.env.CASTLOOP_BUCKET.put = original;
    expect((await setup.call(setup.input("begin", { operation: setup.operation }))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("uploading");
    expect(setup.upload.payloads.every((payload) => !setup.entries.has(stagePayloadKey(setup.upload, payload.asset)))).toBe(true);
  });

  test("unknown service and verification acquisition outcomes remain held without automatic token recovery", async () => {
    for (const token of ["service", "verification"] as const) {
      const setup = await stagingAdminFixture("audio");
      await setup.success(setup.input("claim", { upload: setup.upload }));
      await setup.success(setup.input("begin", { operation: setup.operation }));
      await setup.putPayloads();
      await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true }));
      const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
      setup.env.CASTLOOP_BUCKET.put = (async (key: string, value: string, options?: R2PutOptions) => {
        const written = await original(key, value, options);
        if (token === "service" && key === SERVICE_ADMISSION_KEY || token === "verification" && key === "system/show-publications/daily.json" &&
          parseShowControl(JSON.parse(value)).owner?.verification_id) throw new Error("Unknown acquisition outcome");
        return written;
      }) as typeof setup.env.CASTLOOP_BUCKET.put;
      const result = await setup.call(setup.input("finish", { operation: setup.operation, outcome: "staged" }));
      expect(result.status).toBe(409);
      expect(await result.text()).not.toContain("Unknown acquisition");
      setup.env.CASTLOOP_BUCKET.put = original;
      if (token === "service") expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(1);
      else expect((await readShowControl(setup.env, "daily"))?.value.owner?.verification_id).toBeDefined();
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("uploading");
    }
  });

  test("service token cannot be swapped during the cache gate to authorize a stage claim", async () => {
    const setup = await stagingAdminFixture();
    setup.bindings.cachedAssets.describeRuntime = async () => {
      const current = (await readServiceAdmission(setup.env, "service"))!.value.invocations[0]!;
      await releaseServiceInvocation(setup.env, { serviceId: "service", token: current.token, kind: current.kind });
      const other = await acquireServiceInvocation(setup.env, "service", "m6_recovery");
      expect(other.token).not.toBe(current.token);
      return { schema_version: 1, protocol: "m6-cached-assets-v1" as const, entrypoint: "CachedPublicAssets" as const,
        worker_version_id: setup.versionId, purge_api_available: true as const };
    };
    expect((await setup.call(setup.input("claim", { upload: setup.upload }))).status).toBe(409);
    expect(setup.entries.has(`system/jobs/${setup.upload.operation_id}/upload.json`)).toBe(false);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(1);
  });

  test("candidate routes remain read-only despite the new independent handler and mock readiness", async () => {
    const setup = await stagingAdminFixture();
    const before = setup.writes.length;
    const response = await fetchM6Candidate(new Request<unknown, IncomingRequestCfProperties>(setup.http(setup.input("claim", { upload: setup.upload }))), {
      CASTLOOP_BUCKET: setup.bucket as never, CASTLOOP_ADMIN_KEY: "private-secret", CASTLOOP_DLQ_NAME: setup.config.dlq_name,
      CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" }, CASTLOOP_QUEUE: {} as never,
    }, Object.assign(() => ({ fetch: async () => new Response() }), { invalidate: async () => {}, ...setup.bindings.cachedAssets }));
    expect(response.status).toBe(409);
    expect(setup.writes).toHaveLength(before);
  });

  test("shared response schemas reject arbitrary/foreign/traversal/oversized/duplicated PUT locations", async () => {
    const setup = await stagingAdminFixture();
    const request = setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true });
    expect(stagingAdminRequestSchema.safeParse({ ...request, put_requests_settled: false }).success).toBe(false);
    const payload = { key: stagePayloadKey(setup.upload, "show_metadata"), length: 1, sha256: "a".repeat(64) };
    const response = { schema_version: 1, service_id: "service", result: "started", operation: setup.operation, payloads: [payload] };
    expect(stagingAdminResponseSchema.safeParse(response).success).toBe(true);
    for (const keys of [["system/service.toml"], [payload.key.replace("/daily/", "/foreign/")], [payload.key.replace("show.toml", "../show.toml")],
      [payload.key, payload.key]]) expect(stagingAdminResponseSchema.safeParse({ ...response, payloads: keys.map((key) => ({ ...payload, key })) }).success).toBe(false);
    expect(stagingAdminResponseSchema.safeParse({ ...response, payloads: [{ ...payload, length: 1_000_001 }] }).success).toBe(false);
  });
});
