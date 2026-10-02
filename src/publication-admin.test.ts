import { describe, expect, test } from "bun:test";
import { episodeCommitSchema, parseEpisodeRevision, parseJobStatus, publicationAdminRequestSchema, publicationAdminResponseSchema,
  publicationManifestHash, publicationRequestSchema, showCommitSchema, stagePayloadKey } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import { fetchM6Candidate, queueM6Candidate } from "./m6-routes";
import { handleM6PublicationAdmin } from "./publication-admin";
import { pauseServiceAdmission, readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { publicationTestDigest } from "./test-support/episode-publication";
import { publicationAdminFixture } from "./test-support/publication-admin";

describe("unreleased M6 publication admission and commit boundary", () => {
  test("API claims and commits Show/Episode and both revision types before the same registered Queue consumer publishes", async () => {
    for (const mode of ["show", "episode", "metadata", "audio"] as const) {
      const setup = await publicationAdminFixture(mode);
      const publicBefore = [...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"));
      const claimed = await setup.publicationSuccess(setup.body("claim"));
      expect(claimed.operation).toEqual(setup.publicationOperation);
      expect(claimed.result).toBe("claimed");
      expect(setup.entries.has(setup.markerKey)).toBe(false);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
      const committed = await setup.publicationSuccess(setup.body("commit"));
      expect(committed.result).toBe("committed");
      if (committed.result !== "committed") throw new Error("Expected commit result");
      expect(committed.created).toBe(true);
      expect(committed.key).toBe(setup.markerKey);
      expect(JSON.parse(setup.text(setup.markerKey))).toEqual(setup.frozen.commit);
      expect([...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"))).toEqual(publicBefore);
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
      await queueM6Candidate({ queue: "test-queue", messages: [{ id: "publication", body: { object: { key: setup.markerKey } } }] } as never,
        setup.candidateEnv, setup.cachedAssets, { digest: publicationTestDigest });
      expect(parseJobStatus(setup.text(`system/jobs/${setup.publicationOperation.job_id}/status.toml`)).state).toBe("published");
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
      expect(setup.purges.length).toBeGreaterThan(0);
      if (mode !== "show") {
        const revision = parseEpisodeRevision(setup.text("public/episodes/daily/next/metadata.toml"));
        expect(revision.revision_id).toBe(setup.publicationOperation.job_id);
        expect(setup.entries.has(`public/episodes/daily/next/revisions/${revision.revision_id}.toml`)).toBe(true);
        if (mode === "metadata") {
          expect(new URL(revision.enclosure_url).pathname).toBe(new URL(setup.base!.enclosure_url).pathname);
          expect(setup.entries.has(`public/podcasts/daily/episodes/next/${revision.revision_id}.mp3`)).toBe(false);
        } else expect(setup.entries.has(`public/podcasts/daily/episodes/next/${revision.revision_id}.mp3`)).toBe(true);
        if (setup.base) expect(setup.entries.has(`public/episodes/daily/next/revisions/${setup.base.revision_id}.toml`)).toBe(true);
      }
    }
  });

  test("shared extraction retains old commit validation and rejects foreign/duplicate staging proofs", async () => {
    const setup = await publicationAdminFixture("episode");
    expect(publicationRequestSchema.safeParse(setup.frozen).success).toBe(true);
    expect(publicationAdminRequestSchema.safeParse({ ...setup.body("claim"), secret: "private" }).success).toBe(false);
    expect(publicationRequestSchema.safeParse({ ...setup.frozen, commit: { ...setup.frozen.commit, job_id: crypto.randomUUID() } }).success).toBe(false);
    expect(publicationRequestSchema.safeParse({ ...setup.frozen, staged_uploads: [setup.stages[0]!.operation_id, setup.stages[0]!.operation_id] }).success).toBe(false);
    expect(showCommitSchema.safeParse({ schema_version: 1, kind: "show", show_id: "../daily", job_id: crypto.randomUUID(),
      metadata_sha256: "a".repeat(64), cover_sha256: "b".repeat(64), cover_extension: "jpg" }).success).toBe(false);
    for (const change of [{ committed_at: "2026-02-30T12:00:00Z" }, { committed_at: "2026-10-02T12:00:00+24:00" },
      { audio_length_bytes: 300_000_001 }, { audio_sha256: undefined }, { metadata_sha256: undefined }, { description: "private" }]) {
      expect(episodeCommitSchema.safeParse({ ...setup.frozen.commit, ...change }).success).toBe(false);
    }
  });

  test("auth/method/strict body/service identity checks precede publication side effects", async () => {
    const setup = await publicationAdminFixture();
    const before = setup.writes.length;
    const unauthorized = setup.http(setup.body("claim"), "wrong");
    expect((await handleM6PublicationAdmin(unauthorized, setup.env, setup.bindings))?.status).toBe(401);
    expect(unauthorized.bodyUsed).toBe(false);
    expect((await handleM6PublicationAdmin(setup.http({}, "private-secret", "GET"), setup.env, setup.bindings))?.status).toBe(405);
    expect(await handleM6PublicationAdmin(new Request("https://current.example/admin/other"), setup.env, setup.bindings)).toBeNull();
    for (const body of [{ ...setup.body("claim"), service_id: "foreign" }, { ...setup.body("claim"), ready: true },
      { ...setup.body("claim"), publication: { ...setup.frozen, title: "private" } }, { ...setup.body("commit"), operation: { ...setup.publicationOperation, show_generation: 0 } }]) {
      const result = await setup.call(body);
      expect(result.status).toBe(400);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
    }
    const oversized = new Request("https://current.example/admin/publication", { method: "POST", headers: { "X-Castloop-Key": "private-secret" }, body: "x".repeat(16385) });
    expect((await handleM6PublicationAdmin(oversized, setup.env, setup.bindings))?.status).toBe(400);
    expect(setup.writes).toHaveLength(before);
  });

  test("pause blocks new publication but permits existing reserved admission to commit and drain", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    const pauseId = crypto.randomUUID();
    await pauseServiceAdmission(setup.env, "service", pauseId);
    expect((await setup.call(setup.body("claim"))).status).toBe(409);
    expect((await setup.publicationSuccess(setup.body("commit"))).result).toBe("committed");
    await queueM6Candidate({ queue: "test-queue", messages: [{ id: "publication", body: { object: { key: setup.markerKey } } }] } as never,
      setup.candidateEnv, setup.cachedAssets);
    expect((await readServiceAdmission(setup.env, "service"))?.value.state).toBe("paused");
    expect((await readServiceAdmission(setup.env, "service"))?.value.pause_id).toBe(pauseId);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("changed payload after verification refuses commit, retains admission and never publishes an older copy", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    await setup.bucket.put(stagePayloadKey(setup.stages[0]!, "show_metadata"), "Private changed metadata");
    const result = await setup.call(setup.body("commit"));
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("Private changed metadata");
    expect(setup.entries.has(setup.markerKey)).toBe(false);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("missing staging status/proof and changed Episode base revision fail without a commit marker", async () => {
    for (const change of ["status", "proof", "base"] as const) {
      const setup = await publicationAdminFixture("metadata");
      await setup.publicationSuccess(setup.body("claim"));
      if (change === "status") setup.entries.delete(`system/jobs/${setup.stages[0]!.operation_id}/status.toml`);
      if (change === "proof") setup.entries.delete(`system/jobs/${setup.stages[0]!.operation_id}/upload-progress.json`);
      if (change === "base") await setup.addEpisode("next", "active");
      expect((await setup.call(setup.body("commit"))).status).toBe(409);
      expect(setup.entries.has(setup.markerKey)).toBe(false);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
    }
  });

  test("foreign job/generation cannot commit or replace another reserved publication", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    const owner = (await readShowControl(setup.env, "daily"))?.value.owner;
    for (const operation of [{ ...setup.publicationOperation, job_id: crypto.randomUUID() },
      { ...setup.publicationOperation, show_generation: setup.publicationOperation.show_generation + 1 }]) {
      expect((await setup.call({ ...setup.body("commit"), operation })).status).toBe(409);
    }
    const jobId = crypto.randomUUID();
    expect((await setup.call({ ...setup.body("claim"), publication: { ...setup.frozen,
      request: { ...setup.frozen.request, job_id: jobId }, commit: { ...setup.frozen.commit, job_id: jobId } } })).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toEqual(owner);
    expect(setup.entries.has(setup.markerKey)).toBe(false);
  });

  test("explicit duplicate commit returns the existing marker without rewriting it or sending another Queue message", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    await setup.publicationSuccess(setup.body("commit"));
    const etag = setup.entries.get(setup.markerKey)!.etag;
    const duplicate = await setup.publicationSuccess(setup.body("commit"));
    expect(duplicate.result).toBe("committed");
    if (duplicate.result !== "committed") throw new Error("Expected commit receipt");
    expect(duplicate.created).toBe(false);
    expect(setup.entries.get(setup.markerKey)!.etag).toBe(etag);
    expect(setup.writes.filter((key) => key === setup.markerKey)).toHaveLength(1);
    expect(setup.purges).toEqual([]);
  });

  test("commit PUT response loss leaves the frozen marker and reserved owner rather than starting a different job", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
    let calls = 0;
    setup.env.CASTLOOP_BUCKET.put = (async (key: string, value: string, options?: R2PutOptions) => {
      const written = await original(key, value, options);
      if (key === setup.markerKey) { calls += 1; throw new Error("Private commit response lost"); }
      return written;
    }) as typeof setup.env.CASTLOOP_BUCKET.put;
    const result = await setup.call(setup.body("commit"));
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("Private commit");
    expect(calls).toBe(1);
    expect(setup.entries.has(setup.markerKey)).toBe(true);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    setup.env.CASTLOOP_BUCKET.put = original;
  });

  test("cache-owner or executing-version mismatch refuses publication before frozen request writes", async () => {
    for (const change of ["version", "cache-owner", "legacy"] as const) {
      const setup = await publicationAdminFixture();
      if (change === "version") setup.bindings.versionMetadata.id = crypto.randomUUID();
      if (change === "cache-owner") setup.bindings.cachedAssets.describeRuntime = async () => ({ schema_version: 1,
        protocol: "m6-cached-assets-v1", entrypoint: "CachedPublicAssets", worker_version_id: crypto.randomUUID(), purge_api_available: true });
      if (change === "legacy") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ schema_version: 1,
        service_id: "service", generation: 0, mode: "legacy", state: "open", invocations: [] }));
      expect((await setup.call(setup.body("claim"))).status).toBe(409);
      expect(setup.entries.has(`system/jobs/${setup.publicationOperation.job_id}/publication.json`)).toBe(false);
    }
  });

  test("live commit verification remains registered through pause and the final cache gate", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const original = setup.env.CASTLOOP_BUCKET.head.bind(setup.env.CASTLOOP_BUCKET);
    const payloadKey = stagePayloadKey(setup.stages[0]!, "show_metadata");
    setup.env.CASTLOOP_BUCKET.head = (async (key: string) => {
      if (key === payloadKey) { started.resolve(); await ended.promise; }
      return original(key);
    }) as typeof setup.env.CASTLOOP_BUCKET.head;
    const pending = setup.call(setup.body("commit"));
    await started.promise;
    const held = (await readServiceAdmission(setup.env, "service"))!.value.invocations;
    expect(held).toHaveLength(1);
    expect(held[0]?.kind).toBe("m6_recovery");
    await pauseServiceAdmission(setup.env, "service", crypto.randomUUID());
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual(held);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
    expect(setup.entries.has(setup.markerKey)).toBe(false);
    ended.resolve();
    expect((await pending).status).toBe(200);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    expect((await readServiceAdmission(setup.env, "service"))?.value.state).toBe("paused");
  });

  test("final delivery-gate failure keeps a created commit and returns unknown instead of another publication", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    const describe = setup.bindings.cachedAssets.describeRuntime;
    let reads = 0;
    setup.bindings.cachedAssets.describeRuntime = async () => {
      if (++reads === 2) throw new Error("Private runtime failure");
      return describe();
    };
    const result = await setup.call(setup.body("commit"));
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("Private runtime failure");
    expect(setup.entries.has(setup.markerKey)).toBe(true);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    expect(setup.writes.filter((key) => key === setup.markerKey)).toHaveLength(1);
  });

  test("unknown service-token acquisition leaves the registry held and writes no publication manifest", async () => {
    const setup = await publicationAdminFixture();
    const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
    setup.env.CASTLOOP_BUCKET.put = (async (key: string, value: string, options?: R2PutOptions) => {
      const written = await original(key, value, options);
      if (key === SERVICE_ADMISSION_KEY) throw new Error("Private service acquisition outcome lost");
      return written;
    }) as typeof setup.env.CASTLOOP_BUCKET.put;
    const result = await setup.call(setup.body("claim"));
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("Private service");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(1);
    expect(setup.entries.has(`system/jobs/${setup.publicationOperation.job_id}/publication.json`)).toBe(false);
    expect(setup.entries.has(setup.markerKey)).toBe(false);
    setup.env.CASTLOOP_BUCKET.put = original;
  });

  test("candidate HTTP administration remains closed even with mock readiness and retained verified uploads", async () => {
    const setup = await publicationAdminFixture();
    const before = setup.writes.length;
    const response = await fetchM6Candidate(new Request<unknown, IncomingRequestCfProperties>(setup.http(setup.body("claim"))), setup.candidateEnv, setup.cachedAssets);
    expect(response.status).toBe(409);
    expect(setup.writes).toHaveLength(before);
  });

  test("shared commit response refuses arbitrary paths, foreign target/job and readiness claims", async () => {
    const setup = await publicationAdminFixture();
    const result = { schema_version: 1, service_id: "service", result: "committed", operation: setup.publicationOperation,
      manifest_sha256: await publicationManifestHash(setup.frozen), key: setup.markerKey, created: true };
    expect(publicationAdminResponseSchema.safeParse(result).success).toBe(true);
    for (const key of ["system/service.toml", setup.markerKey.replace("/daily/", "/foreign/"), setup.markerKey.replace(setup.publicationOperation.job_id, crypto.randomUUID()),
      setup.markerKey.replace("commit.json", "../commit.json")]) expect(publicationAdminResponseSchema.safeParse({ ...result, key }).success).toBe(false);
    expect(publicationAdminResponseSchema.safeParse({ ...result, m6_ready: true }).success).toBe(false);
  });
});
