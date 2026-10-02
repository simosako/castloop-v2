import { describe, expect, test } from "bun:test";
import { publicationAdminRequestSchema } from "../packages/shared/src/index";
import { controlRequestHash, readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import { fetchM6Candidate, fetchM6ManagementIntegration, queueM6Candidate } from "./m6-routes";
import type { M6CandidateEnv, M6CachedLoopback } from "./m6-routes";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { stagingAdminFixture } from "./test-support/staging-admin";
import { publicationAdminFixture } from "./test-support/publication-admin";
import { publicationTestDigest } from "./test-support/episode-publication";
import { createHash } from "node:crypto";

type StagingSetup = Awaited<ReturnType<typeof stagingAdminFixture>>;
const digestOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function routeEnv(setup: StagingSetup, sent: unknown[], versionId: string): M6CandidateEnv {
  return { CASTLOOP_BUCKET: setup.bucket as never, CASTLOOP_DLQ_NAME: setup.config.dlq_name,
    CASTLOOP_ADMIN_KEY: "private-secret", CASTLOOP_VERSION_METADATA: { id: versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" },
    CASTLOOP_QUEUE: { send: async (body: unknown) => { sent.push(body); } } as never };
}

function cachedLoopback(setup: StagingSetup): M6CachedLoopback {
  return Object.assign(() => ({ fetch: async () => new Response() }), {
    invalidate: async () => {}, ...setup.bindings.cachedAssets,
  });
}

const post = (path: string, body: unknown, key = "private-secret") =>
  new Request<unknown, IncomingRequestCfProperties>(`https://current.example${path}`, {
    method: "POST", headers: { "X-Castloop-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

const run = async (env: M6CandidateEnv, assets: M6CachedLoopback, path: string, body: unknown) => {
  const response = await fetchM6ManagementIntegration(post(path, body), env, assets, { digest: publicationTestDigest });
  return { response, body: await response.json<unknown>() };
};

describe("unreleased M6 management fetch integration", () => {
  test("staging admission, one-time PUT start, settlement and verification open only after migration", async () => {
    const setup = await stagingAdminFixture("audio");
    const sent: unknown[] = [];
    const env = routeEnv(setup, sent, setup.versionId);
    const assets = cachedLoopback(setup);
    const original = setup.text(SERVICE_ADMISSION_KEY);
    try {
      for (const failure of ["legacy", "missing", "version", "migrating"] as const) {
        if (failure === "legacy") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ schema_version: 1,
          service_id: "service", generation: 0, mode: "legacy", state: "open", invocations: [] }));
        if (failure === "missing") setup.entries.delete(SERVICE_ADMISSION_KEY);
        if (failure === "version") env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
        if (failure === "migrating") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service,
          state: "migrating", pause_id: crypto.randomUUID(), migration: { migration_id: crypto.randomUUID(), request_sha256: "a".repeat(64) } }));
        const writes = setup.writes.length;
        const result = await run(env, assets, "/admin/staging", setup.input("claim", { upload: setup.upload }));
        expect(result.response.status).toBe(409);
        expect(result.response.headers.get("Cache-Control")).toBe("no-store");
        expect(setup.writes).toHaveLength(writes);
        await setup.bucket.put(SERVICE_ADMISSION_KEY, original);
        env.CASTLOOP_VERSION_METADATA.id = setup.versionId;
      }
      const claim = await run(env, assets, "/admin/staging", setup.input("claim", { upload: setup.upload }));
      expect(claim.response.status).toBe(200);
      expect(claim.body).toEqual({ schema_version: 1, service_id: "service", result: "claimed", operation: setup.operation });
      expect((await run(env, assets, "/admin/staging", setup.input("begin", { operation: setup.operation }))).response.status).toBe(200);
      await setup.putPayloads();
      const early = await run(env, assets, "/admin/staging", setup.input("finish", { operation: setup.operation, outcome: "staged" }));
      expect(early.response.status).toBe(409);
      expect((await run(env, assets, "/admin/staging", setup.input("settle", { operation: setup.operation,
        put_requests_settled: true, no_more_puts: true }))).response.status).toBe(200);
      expect((await run(env, assets, "/admin/staging", setup.input("finish", { operation: setup.operation, outcome: "staged" }))).response.status).toBe(200);
      expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
      expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
      expect((await fetchM6ManagementIntegration(post("/admin/staging", setup.input("claim", { upload: setup.upload }), "wrong"),
        env, assets)).status).toBe(401);
      expect((await fetchM6ManagementIntegration(new Request("https://current.example/admin/staging", {
        method: "GET", headers: { "X-Castloop-Key": "private-secret" } }), env, assets)).status).toBe(405);
      expect(sent).toEqual([]);
    } finally {
      await setup.bucket.put(SERVICE_ADMISSION_KEY, original);
    }
  });

  test("publication claim and manifest-bound commit route through integration and publish via the Queue", async () => {
    const setup = await publicationAdminFixture("show");
    const sent: unknown[] = [];
    const env = routeEnv(setup, sent, setup.versionId);
    const assets = setup.cachedAssets;
    const claim = await run(env, assets, "/admin/publication", setup.body("claim"));
    expect(claim.response.status).toBe(200);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("reserved");
    const commit = await run(env, assets, "/admin/publication", setup.body("commit"));
    expect(commit.response.status).toBe(200);
    expect(commit.body).toEqual({ schema_version: 1, service_id: "service", result: "committed",
      operation: setup.publicationOperation, manifest_sha256: digestOf(setup.frozen), key: setup.markerKey, created: true });
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("reserved");
    const changed = { ...setup.body("commit"), manifest_sha256: "0".repeat(64) };
    expect((await run(env, assets, "/admin/publication", changed)).response.status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("reserved");
    expect((await run(env, assets, "/admin/publication", { ...setup.body("commit"), action: "unknown" })).response.status).toBe(400);
    await queueM6Candidate({ queue: setup.config.queue_name, messages: [{ id: "message-1", body: { object: { key: setup.markerKey } } }] } as never,
      env, assets, { digest: publicationTestDigest });
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
    expect(setup.text(setup.statusKey)).toContain("published");
    expect((await run(env, assets, "/admin/publication", setup.body("commit"))).response.status).toBe(409);
    expect(sent).toEqual([]);
  });

  test("lifecycle claim, commit and same-job retry route through integration with one Queue send", async () => {
    const setup = await publicationAdminFixture("episode");
    const sent: unknown[] = [];
    const env = routeEnv(setup, sent, setup.versionId);
    const assets = setup.cachedAssets;
    expect((await run(env, assets, "/admin/publication", setup.body("claim"))).response.status).toBe(200);
    expect((await run(env, assets, "/admin/publication", setup.body("commit"))).response.status).toBe(200);
    await queueM6Candidate({ queue: setup.config.queue_name, messages: [{ id: "message-1", body: { object: { key: setup.markerKey } } }] } as never,
      env, assets, { digest: publicationTestDigest });
    const request = { schema_version: 1 as const, job_id: crypto.randomUUID(), show_id: "daily", kind: "episode" as const, episode_id: "next",
      action: "unpublish" as const, expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      expected_episode_generation: (await readEpisodeLifecycle(setup.env, "daily", "next"))!.generation, created_at: "2026-10-02T12:00:00Z" };
    const confirmation = { operator_confirmed: true as const, request_sha256: await controlRequestHash(request) };
    expect((await run(env, assets, "/admin/lifecycle", { schema_version: 1, service_id: "service", action: "claim", request,
      confirmation })).response.status).toBe(200);
    const commit = await run(env, assets, "/admin/lifecycle", { schema_version: 1, service_id: "service", action: "commit", request,
      confirmation });
    expect(commit.response.status).toBe(200);
    const receipt = commit.body as { key: string; created: boolean };
    expect(receipt.created).toBe(true);
    expect(receipt.key).toBe(`staging/lifecycle/episodes/daily/next/${request.job_id}/commit.json`);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("reserved");
    const retry = await run(env, assets, "/admin/lifecycle", { schema_version: 1, service_id: "service", action: "retry", request,
      confirmation });
    expect(retry.response.status).toBe(200);
    expect((retry.body as { result: string }).result).toBe("requeued");
    expect(sent).toEqual([{ object: { key: receipt.key } }]);
    await queueM6Candidate({ queue: setup.config.queue_name, messages: [{ id: "message-1", body: { object: { key: receipt.key } } }] } as never,
      env, assets);
    const control = (await readShowControl(setup.env, "daily"))!.value;
    expect(control.lifecycle).toBe("active");
    expect(control.owner).toBeUndefined();
    expect((await readEpisodeLifecycle(setup.env, "daily", "next"))!.lifecycle).toBe("unpublished");
    const stale = { ...request, created_at: "2026-10-02T13:00:00Z" };
    expect((await run(env, assets, "/admin/lifecycle", { schema_version: 1, service_id: "service", action: "retry", request: stale,
      confirmation: { operator_confirmed: true, request_sha256: await controlRequestHash(stale) } })).response.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("legacy mutation paths stay closed and foreign service input is rejected before writes", async () => {
    const setup = await stagingAdminFixture();
    const sent: unknown[] = [];
    const env = routeEnv(setup, sent, setup.versionId);
    const assets = cachedLoopback(setup);
    for (const path of ["/admin/shows/reserve", "/admin/publications/claim", "/admin/jobs/retry", "/admin/lifecycle/delete"]) {
      expect((await fetchM6Candidate(post(path, {}), env, assets)).status).toBe(409);
      expect((await fetchM6ManagementIntegration(post(path, {}), env, assets)).status).toBe(409);
    }
    expect((await fetchM6Candidate(post("/admin/migration/status", {}), env, assets)).status).toBeOneOf([404, 405, 409]);
    expect(publicationAdminRequestSchema.safeParse({ schema_version: 1, service_id: "service", action: "claim",
      publication: setup.upload }).success).toBe(false);
    const writes = setup.writes.length;
    expect((await run(env, assets, "/admin/staging", { schema_version: 1, service_id: "foreign", action: "claim",
      upload: setup.upload })).response.status).toBe(400);
    expect(setup.writes).toHaveLength(writes);
    expect(sent).toEqual([]);
  });
});
