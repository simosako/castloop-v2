import { describe, expect, test } from "bun:test";
import { episodeRevisionSchema, stagePayloadKey, stageUploadRequestSchema, stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { StageAsset, StageUploadRequest } from "../packages/shared/src/index";
import { abandonReservedShowOperation, acquireShowExecution, readShowControl } from "./lifecycle-control";
import { claimPublicationOperation, commitOwnedPublication, parsePublicationCommitKey, publicationCommitKey, publicationRequestSchema,
  readFrozenPublicationCommit, verifyPublicationStaging } from "./publication-admission";
import { beginStageUpload, claimStageUpload, settleStageUpload } from "./staging-upload";
import { runStageVerification } from "./staging-verification";
import { lifecycleFixture } from "./test-support/lifecycle";
import { createHash } from "node:crypto";

const SHOW_TEXT = "schema_version = 1\nshow_id = 'daily'\ntitle = 'Private title'\ndescription = 'Private description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n";
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(kind: "show" | "episode" = "show", update?: "metadata" | "audio") {
  const setup = await lifecycleFixture({ kind });
  await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: kind === "show" ? "draft" : "active", generation: 0, feed_generation: 0 }));
  if (kind === "episode") await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
    show_id: "daily", episode_id: "first", lifecycle: update ? "active" : "draft", generation: 0 }));
  const payloads = new Map<string, { bytes: Uint8Array; etag: string; version: string; size: number;
    customMetadata?: Record<string, string>; checksums?: { sha256: ArrayBuffer } }>();
  let version = 0;
  const bucket = { ...setup.bucket,
    async head(key: string) { const payload = payloads.get(key); return payload ? { key, ...payload } : setup.bucket.head(key); },
    async get(key: string, options?: { onlyIf?: { etagMatches?: string } }) {
      const payload = payloads.get(key);
      if (!payload) return setup.bucket.get(key);
      if (options?.onlyIf?.etagMatches && payload.etag !== options.onlyIf.etagMatches) return { key, ...payload };
      return { key, ...payload, body: new Blob([payload.bytes]).stream(),
        async arrayBuffer() { return payload.bytes.slice().buffer; }, async text() { return new TextDecoder().decode(payload.bytes); } };
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const draftJobId = crypto.randomUUID();
  const guid = crypto.randomUUID();
  const metadata = new TextEncoder().encode(kind === "show" ? SHOW_TEXT :
    `schema_version = 1\nepisode_id = 'first'\nguid = '${guid}'\ntitle = 'Private title'\ndescription = 'Private description'\npublished_at = '2026-10-01T12:00:00Z'\n`);
  const media = kind === "show" ? Uint8Array.from([255, 216, 255, 0]) : new TextEncoder().encode("ID3-test-audio");
  const baseRevisionId = crypto.randomUUID();
  if (update) {
    const current = episodeRevisionSchema.parse({ schema_version: 1,
    episode_id: "first", guid, title: "Current title", description: "Current description", published_at: "2026-10-01T12:00:00Z",
    revision_id: baseRevisionId, enclosure_url: `https://example.com/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`,
      content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: checksum(Uint8Array.from([1])), updated_at: "2026-10-01T12:00:00Z" });
    await bucket.put("public/episodes/daily/first/metadata.toml", stringifyToml(current));
    await bucket.put(`public/episodes/daily/first/revisions/${baseRevisionId}.toml`, stringifyToml(current));
    payloads.set(`public${new URL(current.enclosure_url).pathname}`, { bytes: Uint8Array.from([1]), size: 1, etag: "base-audio", version: "base-upload",
      customMetadata: { sha256: current.sha256 }, checksums: { sha256: Uint8Array.from(createHash("sha256").update(Uint8Array.from([1])).digest()).buffer } });
  }
  const inputs: Array<Array<{ asset: StageAsset; bytes: Uint8Array }>> = kind === "show" ? [[
    { asset: "show_metadata", bytes: metadata }, { asset: "cover_jpg", bytes: media },
  ]] : update === "metadata" ? [[{ asset: "episode_metadata", bytes: metadata }]] : update === "audio" ? [[{ asset: "audio", bytes: media }]] :
    [[{ asset: "episode_metadata", bytes: metadata }], [{ asset: "audio", bytes: media }]];
  const staged: StageUploadRequest[] = [];
  function putPayload(key: string, bytes: Uint8Array) { payloads.set(key, { bytes, size: bytes.byteLength, etag: `payload-${++version}`, version: `upload-${version}` }); }
  for (const input of inputs) {
    const generation = (await readShowControl(env, "daily"))!.value.generation;
    const request = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: draftJobId,
      kind, show_id: "daily", expected_show_generation: generation, created_at: "2026-10-01T12:00:00Z",
      ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}),
      payloads: input.map(({ asset, bytes }) => ({ asset, length_bytes: bytes.length, sha256: checksum(bytes) })) });
    staged.push(request);
    const operation = await claimStageUpload(env, request);
    await beginStageUpload(env, operation);
    for (const { asset, bytes } of input) putPayload(stagePayloadKey(request, asset), bytes);
    await settleStageUpload(env, operation, { put_requests_settled: true, no_more_puts: true,
      readback_receipts: request.payloads.map((payload) => {
        const object = payloads.get(stagePayloadKey(request, payload.asset))!;
        return { asset: payload.asset, length_bytes: object.size, sha256: checksum(object.bytes), etag: object.etag, version: object.version };
      }) });
    await runStageVerification(env, operation, "staged");
  }
  const generation = (await readShowControl(env, "daily"))!.value.generation;
  const frozen = publicationRequestSchema.parse({ schema_version: 1,
    request: { schema_version: 1, job_id: draftJobId, show_id: "daily", kind, action: "publish", expected_show_generation: generation,
      ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}), created_at: "2026-10-01T12:00:00Z" },
    commit: kind === "show" ? { schema_version: 1, kind, show_id: "daily", job_id: draftJobId,
      metadata_sha256: checksum(metadata), cover_sha256: checksum(media), cover_extension: "jpg" } : {
      schema_version: 1, kind, show_id: "daily", episode_id: "first", job_id: draftJobId,
      ...(update ? { base_revision_id: baseRevisionId } : {}),
      ...(update !== "audio" ? { metadata_sha256: checksum(metadata) } : {}),
      ...(update !== "metadata" ? { audio_sha256: checksum(media), audio_length_bytes: media.length, duration_seconds: 1 } : {}),
      committed_at: "2026-10-01T12:00:00Z",
    }, staged_uploads: staged.map((request) => request.operation_id) });
  return { ...setup, bucket, env, payloads, putPayload, frozen, staged, draftJobId, markerKey: publicationCommitKey(frozen.commit) };
}

describe("M6 publication admission from verified staging", () => {
  test("Show, initial Episode and metadata/audio-only updates freeze and commit without publishing", async () => {
    for (const [kind, update] of [["show", undefined], ["episode", undefined], ["episode", "metadata"], ["episode", "audio"]] as const) {
      const setup = await fixture(kind, update);
      const beforePayloads = new Map(setup.payloads);
      const beforePublished = new Map([...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/episode-lifecycle/")));
      const operation = await claimPublicationOperation(setup.env, setup.frozen);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
      expect(await claimPublicationOperation(setup.env, setup.frozen)).toEqual(operation);
      expect(await verifyPublicationStaging(setup.env, operation)).toEqual(setup.frozen);
      expect(await commitOwnedPublication(setup.env, operation)).toEqual({ key: setup.markerKey, created: true });
      expect(await readFrozenPublicationCommit(setup.env, setup.markerKey)).toEqual(setup.frozen);
      expect(await commitOwnedPublication(setup.env, operation)).toEqual({ key: setup.markerKey, created: false });
      expect(setup.payloads).toEqual(beforePayloads);
      for (const [key, object] of beforePublished) expect(setup.entries.get(key)).toEqual(object);
      expect(setup.entries.get(`system/jobs/${setup.draftJobId}/publication.json`)!.data).not.toContain("Private title");
      expect(setup.entries.get(`system/jobs/${setup.draftJobId}/publication.json`)!.data).not.toContain("owner@example.com");
      expect(setup.writes.at(-1)).toBe(setup.markerKey);
    }
  });

  test("strict frozen requests and canonical marker paths reject unrelated targets and secret/body fields", async () => {
    const setup = await fixture();
    for (const invalid of [{ secret: "token" }, { staged_uploads: [setup.draftJobId] }, { staged_uploads: [] },
      { staged_uploads: [...setup.frozen.staged_uploads, ...setup.frozen.staged_uploads] },
      { request: { ...setup.frozen.request, action: "restore" } },
      { commit: { ...setup.frozen.commit, show_id: "other" } }, { commit: { ...setup.frozen.commit, title: "Private" } }]) {
      expect(publicationRequestSchema.safeParse({ ...setup.frozen, ...invalid }).success).toBe(false);
    }
    expect(parsePublicationCommitKey(setup.markerKey)).toEqual({ kind: "show", showId: "daily", jobId: setup.draftJobId });
    for (const key of ["staging/shows/../commit.json", setup.markerKey.replace("daily", "Daily"), `${setup.markerKey}/extra`,
      setup.markerKey.replace(setup.draftJobId, "not-a-uuid"), setup.markerKey.replace("shows", "lifecycle/shows")]) {
      expect(parsePublicationCommitKey(key)).toBeNull();
    }
  });

  test("live stage and stopped/deleted targets never receive publication admission", async () => {
    for (const fault of ["live-stage", "unpublished", "deleted"] as const) {
      const setup = await fixture();
      if (fault === "live-stage") {
        const request = stageUploadRequestSchema.parse({ ...setup.staged[0], operation_id: crypto.randomUUID(),
          expected_show_generation: setup.frozen.request.expected_show_generation });
        await claimStageUpload(setup.env, request);
      } else {
        const control = (await readShowControl(setup.env, "daily"))!.value;
        await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...control, lifecycle: fault }));
      }
      await expect(claimPublicationOperation(setup.env, setup.frozen)).rejects.toThrow();
      expect(setup.entries.has(setup.markerKey)).toBe(false);
    }
  });

  test("missing, aborted, foreign or checksum/object-identity-mismatched staging proofs cannot create a marker", async () => {
    for (const fault of ["missing-status", "aborted", "foreign-draft", "hash", "etag", "version", "missing-version", "size"] as const) {
      const setup = await fixture();
      const request = setup.staged[0]!;
      const operation = await claimPublicationOperation(setup.env, setup.frozen);
      if (fault === "missing-status") await setup.bucket.delete(`system/jobs/${request.operation_id}/status.toml`);
      if (fault === "aborted") {
        const key = `system/jobs/${request.operation_id}/upload-progress.json`;
        const progress = JSON.parse(setup.entries.get(key)!.data);
        await setup.bucket.put(key, JSON.stringify({ ...progress, outcome: "aborted", verified_assets: [] }));
      }
      if (fault === "foreign-draft") await setup.bucket.put(`system/jobs/${request.operation_id}/upload.json`, JSON.stringify({ ...request, draft_job_id: crypto.randomUUID() }));
      if (fault === "hash") {
        const key = `system/jobs/${request.operation_id}/upload-progress.json`;
        const progress = JSON.parse(setup.entries.get(key)!.data);
        await setup.bucket.put(key, JSON.stringify({ ...progress, verified_assets: progress.verified_assets.map((asset: { sha256: string }) =>
          ({ ...asset, sha256: "a".repeat(64) })) }));
      }
      if (fault === "etag" || fault === "size") {
        const key = stagePayloadKey(request, "show_metadata");
        setup.putPayload(key, fault === "etag" ? setup.payloads.get(key)!.bytes : new Uint8Array(1));
      }
      if (fault === "version") setup.payloads.get(stagePayloadKey(request, "show_metadata"))!.version = "replacement-upload";
      if (fault === "missing-version") {
        const key = `system/jobs/${request.operation_id}/upload-progress.json`;
        const progress = JSON.parse(setup.entries.get(key)!.data);
        await setup.bucket.put(key, JSON.stringify({ ...progress, verified_assets: progress.verified_assets.map((asset: { version: string }) => {
          const { version: _version, ...legacy } = asset;
          return legacy;
        }) }));
      }
      await expect(commitOwnedPublication(setup.env, operation)).rejects.toThrow();
      expect(setup.entries.has(setup.markerKey)).toBe(false);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.draftJobId);
    }
  });

  test("job reuse with different publication bytes is rejected before rewriting the frozen manifest", async () => {
    const setup = await fixture();
    await claimPublicationOperation(setup.env, setup.frozen);
    const key = `system/jobs/${setup.draftJobId}/publication.json`;
    const before = setup.entries.get(key);
    await expect(claimPublicationOperation(setup.env, { ...setup.frozen, commit: { ...setup.frozen.commit, cover_sha256: "a".repeat(64) } }))
      .rejects.toThrow("different frozen manifest");
    expect(setup.entries.get(key)).toEqual(before);
  });

  test("concurrent commit has one marker creator and response loss recovers from the frozen marker", async () => {
    const setup = await fixture();
    const operation = await claimPublicationOperation(setup.env, setup.frozen);
    const results = await Promise.all(Array.from({ length: 10 }, () => commitOwnedPublication(setup.env, operation)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(9);
    const other = await fixture();
    const next = await claimPublicationOperation(other.env, other.frozen);
    let lost = false;
    const env = { CASTLOOP_BUCKET: { ...other.bucket, async put(...args: Parameters<typeof other.bucket.put>) {
      const written = await other.bucket.put(...args);
      if (!lost && written && args[0] === other.markerKey) { lost = true; throw new Error("Commit response lost"); }
      return written;
    } } } as never;
    await expect(commitOwnedPublication(env, next)).rejects.toThrow("response lost");
    expect(await commitOwnedPublication(env, next)).toEqual({ key: other.markerKey, created: false });
  });

  test("marker/body/path/frozen-control mismatch and legacy markers are never silently upgraded", async () => {
    const setup = await fixture();
    const operation = await claimPublicationOperation(setup.env, setup.frozen);
    await commitOwnedPublication(setup.env, operation);
    await setup.bucket.put(setup.markerKey, JSON.stringify({ ...setup.frozen.commit, metadata_sha256: "a".repeat(64) }));
    await expect(readFrozenPublicationCommit(setup.env, setup.markerKey)).rejects.toThrow("frozen request");
    const legacy = await fixture();
    await legacy.bucket.put(legacy.markerKey, JSON.stringify(legacy.frozen.commit));
    await expect(claimPublicationOperation(legacy.env, legacy.frozen)).rejects.toThrow("frozen request");
    expect((await readShowControl(legacy.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("abandoned or stale admission cannot write a marker, and an already started owner cannot create one", async () => {
    const setup = await fixture();
    const operation = await claimPublicationOperation(setup.env, setup.frozen);
    await abandonReservedShowOperation(setup.env, operation.showId, operation.jobId, operation.generation);
    await expect(commitOwnedPublication(setup.env, operation)).rejects.toThrow("no longer owns");
    await expect(claimPublicationOperation(setup.env, setup.frozen)).rejects.toThrow();
    expect(setup.entries.has(setup.markerKey)).toBe(false);
    const other = await fixture();
    const next = await claimPublicationOperation(other.env, other.frozen);
    await acquireShowExecution(other.env, next.showId, next.jobId, next.generation);
    await expect(commitOwnedPublication(other.env, next)).rejects.toThrow("Only unstarted");
    expect(other.entries.has(other.markerKey)).toBe(false);
  });

  test("wrong base revision and supplied commit checksums reject even successfully verified payloads", async () => {
    const setup = await fixture("episode", "metadata");
    const operation = await claimPublicationOperation(setup.env, { ...setup.frozen, commit: { ...setup.frozen.commit, base_revision_id: crypto.randomUUID() } });
    await expect(commitOwnedPublication(setup.env, operation)).rejects.toThrow("base revision");
    const other = await fixture("episode", "audio");
    const next = await claimPublicationOperation(other.env, { ...other.frozen, commit: { ...other.frozen.commit, audio_sha256: "a".repeat(64) } });
    await expect(commitOwnedPublication(other.env, next)).rejects.toThrow("verification evidence");
  });

  test("manifest and admission response loss recover with exactly the same immutable job", async () => {
    for (const fault of ["manifest", "admission"] as const) {
      const setup = await fixture();
      let lost = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const target = fault === "manifest" ? `system/jobs/${setup.draftJobId}/publication.json` : "system/show-publications/daily.json";
        if (!lost && written && args[0] === target) { lost = true; throw new Error("Publication claim response lost"); }
        return written;
      } } } as never;
      await expect(claimPublicationOperation(env, setup.frozen)).rejects.toThrow("response lost");
      const operation = await claimPublicationOperation(env, setup.frozen);
      expect(operation.generation).toBe(setup.frozen.request.expected_show_generation + 1);
      expect((await readShowControl(env, "daily"))?.value.generation).toBe(operation.generation);
      expect((await commitOwnedPublication(env, operation)).created).toBe(true);
    }
  });

  test("newer stage generations and stale Episode generations cannot authorize publication", async () => {
    for (const fault of ["stage-generation", "episode-generation"] as const) {
      const setup = await fixture("episode", "metadata");
      const operation = await claimPublicationOperation(setup.env, setup.frozen);
      if (fault === "stage-generation") {
        const request = setup.staged[0]!;
        await setup.bucket.put(`system/jobs/${request.operation_id}/upload.json`, JSON.stringify({ ...request,
          expected_show_generation: setup.frozen.request.expected_show_generation + 1 }));
      } else {
        await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
          show_id: "daily", episode_id: "first", lifecycle: "active", generation: 1 }));
      }
      await expect(commitOwnedPublication(setup.env, operation)).rejects.toThrow();
      expect(setup.entries.has(setup.markerKey)).toBe(false);
    }
  });

  test("frozen control mismatch never authenticates a retained marker", async () => {
    const setup = await fixture();
    const operation = await claimPublicationOperation(setup.env, setup.frozen);
    await commitOwnedPublication(setup.env, operation);
    await setup.bucket.put(`system/jobs/${setup.draftJobId}/request.toml`, stringifyLifecycleToml({ ...setup.frozen.request,
      expected_show_generation: setup.frozen.request.expected_show_generation + 1 }));
    await expect(readFrozenPublicationCommit(setup.env, setup.markerKey)).rejects.toThrow("frozen request");
    await expect(commitOwnedPublication(setup.env, operation)).rejects.toThrow();
  });

  test("metadata-only publication verifies unchanged audio and immutable history before committing", async () => {
    for (const fault of ["history", "audio", "checksum"] as const) {
      const setup = await fixture("episode", "metadata");
      const operation = await claimPublicationOperation(setup.env, setup.frozen);
      if (fault === "history") {
        for (const key of setup.entries.keys()) if (key.includes("/revisions/")) await setup.bucket.delete(key);
      } else {
        const key = [...setup.payloads.keys()].find((key) => key.startsWith("public/"))!;
        if (fault === "audio") setup.payloads.delete(key);
        else setup.payloads.get(key)!.customMetadata = { sha256: "b".repeat(64) };
      }
      await expect(commitOwnedPublication(setup.env, operation)).rejects.toThrow(fault === "history" ? "history" : "base audio");
      expect(setup.entries.has(setup.markerKey)).toBe(false);
    }
  });
});
