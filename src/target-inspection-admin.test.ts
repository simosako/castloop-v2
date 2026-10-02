import { describe, expect, test } from "bun:test";
import { serviceAdmissionSchema, stringifyToml, targetInspectionRequestSchema, targetInspectionResponseSchema } from "../packages/shared/src/index";
import type { TargetInspectionRequest } from "../packages/shared/src/index";
import { TargetInspectionClient } from "../packages/cli/src/target-inspection-client";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { fetchM6Candidate, fetchM6ManagementIntegration } from "./m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "./m6-routes";
import { SERVICE_ADMISSION_KEY } from "./service-admission";
import { handleM6TargetInspection } from "./target-inspection-admin";
import { stagingAdminFixture } from "./test-support/staging-admin";

async function fixture() {
  const setup = await stagingAdminFixture();
  const input = (episodeId?: string, showId = "daily"): TargetInspectionRequest => ({ schema_version: 1,
    service_id: setup.config.service_id, kind: episodeId ? "episode" : "show", show_id: showId, ...(episodeId ? { episode_id: episodeId } : {}) });
  const request = (body: unknown, key = "private-secret", method = "POST") => new Request("https://current.example/admin/target", {
    method, headers: { "X-Castloop-Key": key }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  const call = async (body: unknown) => {
    const response = await handleM6TargetInspection(request(body), setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected inspection route");
    return response;
  };
  const client = new TargetInspectionClient(setup.config, "private-secret", async (url, init) => {
    const response = await handleM6TargetInspection(new Request(url, init), setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected inspection route");
    return response;
  });
  return { ...setup, input, request, call, client };
}

describe("read-only M6 target generation and base revision inspection", () => {
  test("Show and missing target inspections do not write, reserve, initialize or authorize operations", async () => {
    const setup = await fixture();
    const before = [...setup.entries];
    const writes = [...setup.writes];
    const show = await setup.client.inspect(setup.input());
    expect(show.show?.lifecycle).toBe("active");
    expect(show.show?.generation).toBe((await readShowControl(setup.env, "daily"))!.value.generation);
    expect(show.episode).toBeNull();
    expect(show.current_revision).toBeNull();
    expect(show.authorizes_operation).toBe(false);
    expect(show.payloads_verified).toBe(false);
    expect((await setup.client.inspect(setup.input(undefined, "missing"))).show).toBeNull();
    expect(setup.writes).toEqual(writes);
    expect([...setup.entries]).toEqual(before);
  });

  for (const lifecycle of ["active", "unpublished"] as const) {
    test(`${lifecycle} Episode returns its exact current/history-checked base without media verification`, async () => {
      const setup = await fixture();
      const revision = await setup.addEpisode("first", lifecycle);
      const writes = [...setup.writes];
      const response = await setup.client.inspect(setup.input("first"));
      expect(response.current_revision).toEqual(revision);
      expect(response.episode).toEqual({ lifecycle, generation: 0 });
      expect(response.snapshot_only).toBe(true);
      expect(response.payloads_verified).toBe(false);
      expect(setup.writes).toEqual(writes);
      expect(setup.bodyReads.filter((key) => key.endsWith(".mp3"))).toEqual([]);
    });
  }

  test("draft, missing and deleted Episode controls never return a retained payload as a reusable base", async () => {
    const setup = await fixture();
    await setup.addEpisode("draft", "draft");
    await setup.addEpisode("deleted", "deleted");
    for (const id of ["draft", "missing", "deleted"]) expect((await setup.client.inspect(setup.input(id))).current_revision).toBeNull();
  });

  test("unfinished Show owner suppresses base reading instead of authorizing consumer recovery", async () => {
    const setup = await fixture();
    await setup.addEpisode("first", "active");
    await claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), kind: "episode", show_id: "daily", episode_id: "first",
      action: "stage", expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      expected_episode_generation: 0, created_at: "2026-10-02T12:00:00Z" });
    const response = await setup.client.inspect(setup.input("first"));
    expect(response.unfinished_show_operation).toBe(true);
    expect(response.current_revision).toBeNull();
    expect(response.authorizes_operation).toBe(false);
  });

  test("paused admission can be inspected without opening it or adopting a legacy runtime", async () => {
    const setup = await fixture();
    await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify(serviceAdmissionSchema.parse(
      { ...setup.service, state: "paused", pause_id: crypto.randomUUID(), generation: 1 })));
    const writes = [...setup.writes];
    expect((await setup.client.inspect(setup.input())).admission_state).toBe("paused");
    expect(setup.writes).toEqual(writes);
    await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, mode: "legacy", readiness: undefined }));
    expect((await setup.call(setup.input())).status).toBe(409);
  });

  test("inconsistent history, orphan metadata and oversized current snapshots fail closed", async () => {
    for (const invalid of ["history", "orphan", "oversized"]) {
      const setup = await fixture();
      const revision = await setup.addEpisode("first", "active");
      if (!revision) throw new Error("Missing fixture revision");
      const key = "public/episodes/daily/first/metadata.toml";
      if (invalid === "history") await setup.bucket.put(`public/episodes/daily/first/revisions/${revision.revision_id}.toml`,
        stringifyToml({ ...revision, title: "Different history" }));
      if (invalid === "orphan") setup.entries.delete("system/episode-lifecycle/daily/first.toml");
      if (invalid === "oversized") await setup.bucket.put(key, "x".repeat(1_000_001));
      const writes = [...setup.writes];
      expect((await setup.call(setup.input("first"))).status).toBe(409);
      expect(setup.writes).toEqual(writes);
    }
  });

  test("a metadata ETag change during history IO is rejected even if its parsed contents are identical", async () => {
    const setup = await fixture();
    const revision = await setup.addEpisode("first", "active");
    if (!revision) throw new Error("Missing fixture revision");
    const env = { ...setup.env, CASTLOOP_BUCKET: { ...setup.bucket, get: async (key: string) => {
      const object = await setup.bucket.get(key);
      if (key.includes("/revisions/")) await setup.bucket.put("public/episodes/daily/first/metadata.toml", stringifyToml(revision));
      return object;
    } } };
    const response = await handleM6TargetInspection(setup.request(setup.input("first")), env as never, setup.bindings);
    expect(response?.status).toBe(409);
  });

  test("authentication, strict target schemas, readiness and client identity all fail closed", async () => {
    const setup = await fixture();
    expect((await handleM6TargetInspection(setup.request(setup.input(), "wrong"), setup.env, setup.bindings))?.status).toBe(401);
    expect((await handleM6TargetInspection(setup.request(setup.input(), "private-secret", "GET"), setup.env, setup.bindings))?.status).toBe(405);
    expect((await setup.call({ ...setup.input(), episode_id: "first" })).status).toBe(400);
    expect((await setup.call({ ...setup.input(), service_id: "other" })).status).toBe(400);
    expect(() => targetInspectionRequestSchema.parse({ ...setup.input(), title: "private" })).toThrow();
    const valid = await setup.client.inspect(setup.input());
    expect(() => targetInspectionResponseSchema.parse({ ...valid, authorizes_operation: true })).toThrow();
    const falseClient = new TargetInspectionClient(setup.config, "private-secret", async () => Response.json(
      { ...valid, request: { ...valid.request, show_id: "other" } }, { headers: { "Cache-Control": "no-store" } }));
    await expect(falseClient.inspect(setup.input())).rejects.toThrow("exact target");
    const bindings = { ...setup.bindings, versionMetadata: { id: crypto.randomUUID() } };
    expect((await handleM6TargetInspection(setup.request(setup.input()), setup.env, bindings))?.status).toBe(409);
  });

  test("large valid metadata remains bounded without raising the other management response budgets", async () => {
    const setup = await fixture();
    const revision = await setup.addEpisode("first", "active");
    if (!revision) throw new Error("Missing fixture revision");
    const large = { ...revision, description: "d".repeat(70_000) };
    await setup.bucket.put("public/episodes/daily/first/metadata.toml", stringifyToml(large));
    await setup.bucket.put(`public/episodes/daily/first/revisions/${revision.revision_id}.toml`, stringifyToml(large));
    expect((await setup.client.inspect(setup.input("first"))).current_revision?.description.length).toBe(70_000);
  });

  test("the internal integration handles inspection while the default candidate keeps the route closed", async () => {
    const setup = await fixture();
    const loopback = Object.assign(() => ({ fetch: async () => new Response("unused") }), {
      invalidate: async () => {}, describeRuntime: setup.bindings.cachedAssets.describeRuntime,
    }) satisfies M6CachedLoopback;
    const env: M6CandidateEnv = { ...setup.env, CASTLOOP_DLQ_NAME: setup.config.dlq_name,
      CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" },
      CASTLOOP_QUEUE: { send: async () => {} } } as never;
    const http = () => new Request<unknown, IncomingRequestCfProperties>(setup.request(setup.input()));
    expect((await fetchM6Candidate(http(), env, loopback)).status).not.toBe(200);
    const response = await fetchM6ManagementIntegration(http(), env, loopback);
    expect(response.status).toBe(200);
    expect(targetInspectionResponseSchema.parse(await response.json()).authorizes_operation).toBe(false);
  });
});
