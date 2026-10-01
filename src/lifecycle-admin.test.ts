import { describe, expect, test } from "bun:test";
import { lifecycleAdminRequestSchema, lifecycleAdminResponseSchema, lifecycleCommitKey, parseEpisodeRevision, parseJobStatus,
  parseShowControl } from "../packages/shared/src/index";
import { handleM6LifecycleAdmin } from "./lifecycle-admin";
import { acquireServiceInvocation, pauseServiceAdmission, readServiceAdmission, releaseServiceInvocation, SERVICE_ADMISSION_KEY } from "./service-admission";
import { classifyLifecycleDeletionKey } from "./lifecycle-deletion";
import { controlRequestHash, readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import { fetchM6Candidate } from "./m6-routes";
import { handleM6StagingAdmin } from "./staging-admin";
import { lifecycleAdminFixture } from "./test-support/lifecycle-admin";

describe("unreleased lifecycle management with read-only previews and explicit confirmations", () => {
  test("Show/Episode unpublish, restore and bounded deletion use the API and registered Queue while preserving tombstones", async () => {
    for (const kind of ["show", "episode"] as const) {
      const setup = await lifecycleAdminFixture();
      const revision = parseEpisodeRevision(setup.text("public/episodes/daily/next/metadata.toml"));
      const publicPath = kind === "show" ? "/podcasts/daily/feed.xml" : new URL(revision.enclosure_url).pathname;
      const publicStatus = async () => (await fetchM6Candidate(new Request<unknown, IncomingRequestCfProperties>(`https://current.example${publicPath}`),
        setup.candidateEnv, setup.cachedAssets)).status;
      const immutableBefore = [...setup.entries].filter(([key]) => key.endsWith(".mp3") || key.includes("/revisions/"));
      const stop = await setup.operationRequest(kind, "unpublish");
      const writes = setup.writes.length;
      const preview = await setup.success(await setup.body("dry-run", stop));
      expect(preview.result).toBe("preview");
      if (preview.result !== "preview") throw new Error("Expected preview");
      expect(preview.authorizes_operation).toBe(false);
      expect(preview.payloads_verified).toBe(false);
      expect(preview.eligible).toBe(true);
      expect(setup.writes).toHaveLength(writes);
      await setup.execute(stop);
      expect(await publicStatus()).toBe(404);
      expect([...setup.entries].filter(([key]) => key.endsWith(".mp3") || key.includes("/revisions/"))).toEqual(immutableBefore);
      expect(parseJobStatus(setup.text(`system/jobs/${stop.job_id}/status.toml`)).state).toBe("completed");
      const restore = await setup.operationRequest(kind, "restore");
      await setup.execute(restore);
      expect(await publicStatus()).toBe(200);
      expect([...setup.entries].filter(([key]) => key.endsWith(".mp3") || key.includes("/revisions/"))).toEqual(immutableBefore);
      const deletion = await setup.operationRequest(kind, "delete");
      const deleted = await setup.execute(deletion);
      expect(deleted.invocations).toBeGreaterThan(1);
      expect(await publicStatus()).toBe(410);
      const target = kind === "show" ? { kind: "show" as const, showId: "daily" } : { kind: "episode" as const, showId: "daily", episodeId: "next" };
      expect([...setup.entries.keys()].some((key) => classifyLifecycleDeletionKey(target, key) === "payload")).toBe(false);
      expect(setup.entries.has(deleted.result.key)).toBe(true);
      expect(setup.entries.has(`system/jobs/${deletion.job_id}/request.toml`)).toBe(true);
      expect(parseJobStatus(setup.text(`system/jobs/${deletion.job_id}/status.toml`)).state).toBe("completed");
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
      expect((await readEpisodeLifecycle(setup.env, "daily", "next"))?.lifecycle).toBe("deleted");
      expect((await readEpisodeLifecycle(setup.env, "daily", "untouched"))?.lifecycle).toBe(kind === "show" ? "deleted" : "active");
    }
  });

  test("delete preview is one bounded read-only page and never produces a deletion capability", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "delete");
    const before = new Map(setup.entries);
    const writes = setup.writes.length;
    const result = await setup.success({ ...await setup.body("dry-run", request), scope_index: 1, maximum_objects: 1 });
    if (result.result !== "preview") throw new Error("Expected preview");
    expect(result.deletion_page?.payload_objects).toBe(1);
    expect(result.deletion_page?.scope_complete).toBe(false);
    expect(result.deletion_page?.next_cursor).toBeDefined();
    expect(result.deletion_page?.authorizes_deletion).toBe(false);
    expect(result.deletion_page?.retains_operational_records).toBe(true);
    expect(result.request_sha256).toBe(await controlRequestHash(request));
    expect(setup.entries).toEqual(before);
    expect(setup.writes).toHaveLength(writes);
    expect(JSON.stringify(result)).not.toContain("Private Episode description");
  });

  test("preview reports unknown object counts with fixed codes, not arbitrary private object names", async () => {
    const setup = await lifecycleAdminFixture();
    await setup.bucket.put("public/episodes/daily/next/Private-email-owner@example.com", "private");
    const before = setup.writes.length;
    const request = await setup.operationRequest("episode", "delete");
    const result = await setup.success({ ...await setup.body("dry-run", request), scope_index: 1 });
    if (result.result !== "preview") throw new Error("Expected preview");
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("unknown_payload_key");
    expect(result.deletion_page?.unknown_objects).toBe(1);
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
    expect(setup.writes).toHaveLength(before);
  });

  test("preview rejects service/runtime/target changes during its reads without acquiring or stealing a token", async () => {
    for (const change of ["service", "target", "cache-owner", "config"] as const) {
      const setup = await lifecycleAdminFixture();
      const request = await setup.operationRequest("show", "unpublish");
      const describe = setup.bindings.cachedAssets.describeRuntime;
      if (change === "target") {
        const head = setup.env.CASTLOOP_BUCKET.head.bind(setup.env.CASTLOOP_BUCKET);
        setup.env.CASTLOOP_BUCKET.head = (async (key: string) => {
          if (key === `system/jobs/${request.job_id}/status.toml`) {
            const current = (await readShowControl(setup.env, "daily"))!.value;
            await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...current, generation: current.generation + 1 }));
          }
          return head(key);
        }) as typeof setup.env.CASTLOOP_BUCKET.head;
      }
      let reads = 0;
      setup.bindings.cachedAssets.describeRuntime = async () => {
        if (++reads === 1) {
          if (change === "service") await pauseServiceAdmission(setup.env, "service", crypto.randomUUID());
        }
        if (reads === 2 && change === "config") await setup.bucket.put("system/service.toml", setup.text("system/service.toml"));
        if (change === "cache-owner") return { ...await describe(), worker_version_id: crypto.randomUUID() };
        return describe();
      };
      const result = await setup.call(await setup.body("dry-run", request));
      expect(result.status).toBe(409);
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
      expect(setup.entries.has(`system/jobs/${request.job_id}/request.toml`)).toBe(false);
    }
  });

  test("read-only preview observes existing tokens and pause but does not create or release them", async () => {
    const setup = await lifecycleAdminFixture();
    const invocation = await acquireServiceInvocation(setup.env, "service", "m6_recovery");
    await pauseServiceAdmission(setup.env, "service", crypto.randomUUID());
    const before = new Map(setup.entries);
    const request = await setup.operationRequest("episode", "unpublish");
    const result = await setup.success(await setup.body("dry-run", request));
    if (result.result !== "preview") throw new Error("Expected preview");
    expect(result.admission_state).toBe("paused");
    expect(result.blockers).toContain("service_paused");
    expect(result.eligible).toBe(false);
    expect(setup.entries).toEqual(before);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations[0]?.token).toBe(invocation.token);
    await releaseServiceInvocation(setup.env, invocation);
  });

  test("delete requires both explicit acknowledgements and exact request confirmation before any write", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "delete");
    const body = await setup.body("claim", request);
    const confirmation = body.confirmation!;
    const before = setup.writes.length;
    for (const input of [{ ...body, confirmation: { ...confirmation, irreversible_delete_acknowledged: undefined } },
      { ...body, confirmation: { ...confirmation, retained_records_acknowledged: undefined } },
      { ...body, confirmation: { ...confirmation, irreversible_delete_acknowledged: false } },
      { ...body, confirmation: { ...confirmation, operator_confirmed: false } },
      { ...body, confirmation: { ...confirmation, request_sha256: "f".repeat(64) } },
      { ...body, request: { ...request, created_at: "2026-10-02T13:00:00Z" } }]) {
      expect((await setup.call(input)).status).toBe(400);
    }
    expect(setup.writes).toHaveLength(before);
    expect(lifecycleAdminRequestSchema.safeParse({ ...body, request: { ...request, action: "publish" } }).success).toBe(false);
    expect(lifecycleAdminRequestSchema.safeParse({ ...body, request: { ...request, action: "stage" } }).success).toBe(false);
  });

  test("confirmation cannot be reused for another kind, ID, generation or lifecycle action", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "unpublish");
    const body = await setup.body("claim", request);
    for (const change of [{ job_id: crypto.randomUUID() }, { episode_id: "untouched" },
      { expected_episode_generation: request.expected_episode_generation! + 1 }, { action: "restore" }]) {
      expect((await setup.call({ ...body, request: { ...request, ...change } })).status).toBe(400);
    }
    await setup.success(body);
    const altered = { ...request, created_at: "2026-10-02T13:00:00Z" };
    expect((await setup.call(await setup.body("commit", altered))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(request.job_id);
  });

  test("preview is not a reservation and cannot authorize a stale claim after another operation", async () => {
    const setup = await lifecycleAdminFixture();
    const first = await setup.operationRequest("episode", "unpublish");
    await setup.success(await setup.body("dry-run", first));
    await setup.execute(await setup.operationRequest("episode", "unpublish"));
    expect((await setup.call(await setup.body("claim", first))).status).toBe(409);
    const result = await setup.success(await setup.body("dry-run", first));
    if (result.result !== "preview") throw new Error("Expected preview");
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("target_not_eligible");
  });

  test("unfinished publication/upload owner blocks a lifecycle claim without releasing or overwriting it", async () => {
    const setup = await lifecycleAdminFixture();
    const stage = { ...setup.upload, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
      expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      expected_episode_generation: (await readEpisodeLifecycle(setup.env, "daily", "next"))!.generation };
    const staged = await handleM6StagingAdmin(new Request("https://current.example/admin/staging", { method: "POST", headers: { "X-Castloop-Key": "private-secret" },
      body: JSON.stringify({ schema_version: 1, service_id: "service", action: "claim", upload: stage }) }), setup.env, setup.bindings);
    expect(staged?.status).toBe(200);
    const owner = (await readShowControl(setup.env, "daily"))?.value.owner;
    const request = await setup.operationRequest("episode", "delete");
    const preview = await setup.success(await setup.body("dry-run", request));
    if (preview.result !== "preview") throw new Error("Expected preview");
    expect(preview.blockers).toContain("unfinished_show_operation");
    expect((await setup.call(await setup.body("claim", request))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toEqual(owner);
  });

  test("pause refuses new claims but allows an already confirmed reserved job to commit and drain", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "unpublish");
    await setup.success(await setup.body("claim", request));
    const pauseId = crypto.randomUUID();
    await pauseServiceAdmission(setup.env, "service", pauseId);
    expect((await setup.call(await setup.body("claim", request))).status).toBe(409);
    const result = await setup.success(await setup.body("commit", request));
    if (result.result !== "committed") throw new Error("Expected marker");
    await setup.consume(result.key);
    expect((await readServiceAdmission(setup.env, "service"))?.value.pause_id).toBe(pauseId);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("strict authentication/method/body checks and foreign service validation precede writes", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "unpublish");
    const body = await setup.body("claim", request);
    const before = setup.writes.length;
    const unauthorized = setup.http(body, "wrong");
    expect((await handleM6LifecycleAdmin(unauthorized, setup.env, setup.bindings))?.status).toBe(401);
    expect(unauthorized.bodyUsed).toBe(false);
    expect((await handleM6LifecycleAdmin(setup.http({}, "private-secret", "GET"), setup.env, setup.bindings))?.status).toBe(405);
    expect(await handleM6LifecycleAdmin(new Request("https://current.example/admin/other"), setup.env, setup.bindings)).toBeNull();
    for (const input of [{ ...body, service_id: "foreign" }, { ...body, cutover_verified: true },
      { ...body, request: { ...request, title: "private" } }, { ...body, request: { ...request, kind: "episode" } },
      { ...await setup.body("dry-run", request), scope_index: 1 }]) expect((await setup.call(input)).status).toBe(400);
    expect(setup.writes).toHaveLength(before);
  });

  test("unknown service acquisition and lifecycle commit PUT outcomes are retained without automatic retries", async () => {
    for (const change of ["service", "commit"] as const) {
      const setup = await lifecycleAdminFixture();
      const request = await setup.operationRequest("show", "unpublish");
      const key = lifecycleCommitKey({ kind: request.kind, show_id: request.show_id, job_id: request.job_id });
      if (change === "commit") await setup.success(await setup.body("claim", request));
      const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
      let failures = 0;
      setup.env.CASTLOOP_BUCKET.put = (async (name: string, value: string, options?: R2PutOptions) => {
        const result = await original(name, value, options);
        if (name === (change === "service" ? SERVICE_ADMISSION_KEY : key)) { failures += 1; throw new Error("Private outcome unknown"); }
        return result;
      }) as typeof setup.env.CASTLOOP_BUCKET.put;
      const result = await setup.call(await setup.body(change === "service" ? "claim" : "commit", request));
      expect(result.status).toBe(409);
      expect(await result.text()).not.toContain("Private outcome");
      expect(failures).toBe(1);
      if (change === "service") expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(1);
      else {
        expect(setup.entries.has(key)).toBe(true);
        expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
      }
      setup.env.CASTLOOP_BUCKET.put = original;
    }
  });

  test("same marker is not rewritten and its schema refuses arbitrary paths or premature preview permissions", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "unpublish");
    await setup.success(await setup.body("claim", request));
    const first = await setup.success(await setup.body("commit", request));
    if (first.result !== "committed") throw new Error("Expected marker");
    const etag = setup.entries.get(first.key)!.etag;
    const second = await setup.success(await setup.body("commit", request));
    if (second.result !== "committed") throw new Error("Expected marker");
    expect(second.created).toBe(false);
    expect(setup.entries.get(first.key)!.etag).toBe(etag);
    expect(lifecycleAdminResponseSchema.safeParse({ ...first, key: "system/service.toml" }).success).toBe(false);
    const preview = await setup.success(await setup.body("dry-run", request));
    expect(lifecycleAdminResponseSchema.safeParse({ ...preview, authorizes_operation: true }).success).toBe(false);
    expect(lifecycleAdminResponseSchema.safeParse({ ...preview, payloads_verified: true }).success).toBe(false);
  });

  test("candidate entrypoint still rejects all lifecycle writes and mock readiness does not open commands", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "delete");
    const before = setup.writes.length;
    const result = await fetchM6Candidate(new Request<unknown, IncomingRequestCfProperties>(setup.http(await setup.body("claim", request))),
      setup.candidateEnv, setup.cachedAssets);
    expect(result.status).toBe(409);
    expect(setup.writes).toHaveLength(before);
    expect(parseShowControl(JSON.parse(setup.text("system/show-publications/daily.json"))).lifecycle).toBe("active");
  });

  test("preview is only admission eligibility and never skips saved-payload validation for restoration", async () => {
    const setup = await lifecycleAdminFixture();
    await setup.execute(await setup.operationRequest("episode", "unpublish"));
    const revision = parseEpisodeRevision(setup.text("public/episodes/daily/next/metadata.toml"));
    await setup.bucket.delete(`public${new URL(revision.enclosure_url).pathname}`);
    const request = await setup.operationRequest("episode", "restore");
    const preview = await setup.success(await setup.body("dry-run", request));
    if (preview.result !== "preview") throw new Error("Expected preview");
    expect(preview.eligible).toBe(true);
    expect(preview.payloads_verified).toBe(false);
    expect(preview.authorizes_operation).toBe(false);
    await setup.success(await setup.body("claim", request));
    const committed = await setup.success(await setup.body("commit", request));
    if (committed.result !== "committed") throw new Error("Expected marker");
    await expect(setup.consume(committed.key)).rejects.toThrow();
    expect((await readEpisodeLifecycle(setup.env, "daily", "next"))?.lifecycle).toBe("unpublished");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("processing");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("target-specific paging and empty/oversized lifecycle bodies are refused before mutation", async () => {
    const setup = await lifecycleAdminFixture();
    const episode = await setup.operationRequest("episode", "delete");
    const show = await setup.operationRequest("show", "delete");
    const before = setup.writes.length;
    for (const input of [{ ...await setup.body("dry-run", episode), scope_index: 3 },
      { ...await setup.body("dry-run", show), scope_index: 0, cursor: "opaque" },
      { ...await setup.body("dry-run", episode), maximum_objects: 101 }]) expect((await setup.call(input)).status).toBe(400);
    for (const body of ["", "x".repeat(16385)]) {
      expect((await handleM6LifecycleAdmin(new Request("https://current.example/admin/lifecycle", { method: "POST",
        headers: { "X-Castloop-Key": "private-secret" }, body }), setup.env, setup.bindings))?.status).toBe(400);
    }
    expect(setup.writes).toHaveLength(before);
  });

  test("deleted ID is not restorable or reusable even with a fresh job and matching new generation", async () => {
    const setup = await lifecycleAdminFixture();
    await setup.execute(await setup.operationRequest("episode", "delete"));
    const request = await setup.operationRequest("episode", "restore");
    const preview = await setup.success(await setup.body("dry-run", request));
    if (preview.result !== "preview") throw new Error("Expected preview");
    expect(preview.blockers).toContain("target_not_eligible");
    expect((await setup.call(await setup.body("claim", request))).status).toBe(409);
    expect((await readEpisodeLifecycle(setup.env, "daily", "next"))?.lifecycle).toBe("deleted");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("legacy/missing readiness, foreign version and malformed records make preview fail closed without registry writes", async () => {
    for (const change of ["legacy", "version", "record"] as const) {
      const setup = await lifecycleAdminFixture();
      const request = await setup.operationRequest("show", "unpublish");
      if (change === "legacy") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ schema_version: 1,
        service_id: "service", generation: 0, mode: "legacy", state: "open", invocations: [] }));
      if (change === "version") setup.bindings.versionMetadata.id = crypto.randomUUID();
      if (change === "record") await setup.bucket.put("system/show-publications/daily.json", "Private invalid control");
      const before = setup.writes.length;
      const result = await setup.call(await setup.body("dry-run", request));
      expect(result.status).toBe(409);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(await result.text()).not.toContain("Private invalid");
      expect(setup.writes).toHaveLength(before);
    }
  });
});
