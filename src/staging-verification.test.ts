import { describe, expect, test } from "bun:test";
import { episodeRevisionSchema, parseEpisodeDraft, parseJobStatus, parseShowMetadata, stagePayloadKey, stageUploadRequestSchema,
  stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import { acquireStageVerification, digestStageStream, releaseStageVerification, runStageVerification } from "./staging-verification";
import type { StageStreamDigest } from "./staging-verification";
import { beginStageUpload, claimStageUpload, readStageUploadProgress, requireStageUpload, settleStageUpload } from "./staging-upload";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { lifecycleFixture } from "./test-support/lifecycle";
import { createHash } from "node:crypto";

const SHOW_TEXT = "schema_version = 1\nshow_id = 'daily'\ntitle = 'Private Show title'\ndescription = 'Private description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n";

const digest: StageStreamDigest = async (body, length) => {
  const hash = createHash("sha256");
  let received = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > length) throw new Error("Stream size mismatch");
      hash.update(chunk.value);
    }
  } finally { reader.releaseLock(); }
  if (received !== length) throw new Error("Stream size mismatch");
  return hash.digest("hex");
};

async function fixture(asset: "show" | "audio" | "episode_metadata" = "show", invalid?: "image" | "metadata") {
  const kind = asset === "show" ? "show" : "episode";
  const base = await lifecycleFixture({ kind });
  await base.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: kind === "show" ? "draft" : "active", generation: 0, feed_generation: 0 }));
  if (kind === "episode") await base.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({
    schema_version: 1, show_id: "daily", episode_id: "first", lifecycle: "draft", generation: 0,
  }));
  const payloads = new Map<string, { bytes: Uint8Array; etag: string; size: number }>();
  const bodyReads: string[] = [];
  let revision = 0;
  const bucket = {
    ...base.bucket,
    async head(key: string) {
      const payload = payloads.get(key);
      return payload ? { key, ...payload } : base.bucket.head(key);
    },
    async get(key: string, options?: { onlyIf?: { etagMatches?: string } }) {
      const payload = payloads.get(key);
      if (!payload) return base.bucket.get(key);
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== payload.etag) return { key, ...payload };
      bodyReads.push(key);
      return { key, ...payload, body: new Blob([payload.bytes]).stream(),
        async arrayBuffer() { if (key.endsWith("audio.mp3")) throw new Error("Audio must not be buffered"); return payload.bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(payload.bytes); }, async json() { return JSON.parse(new TextDecoder().decode(payload.bytes)); } };
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const contents = asset === "show" ? [
    { asset: "show_metadata", bytes: new TextEncoder().encode(invalid === "metadata" ? "Private invalid metadata" : SHOW_TEXT) },
    { asset: "cover_jpg", bytes: Uint8Array.from(invalid === "image" ? [1, 2, 3, 4] : [255, 216, 255, 0]) },
  ] : asset === "audio" ? [{ asset: "audio", bytes: new TextEncoder().encode("ID3-test-audio") }] :
    [{ asset: "episode_metadata", bytes: new TextEncoder().encode(`schema_version = 1\nepisode_id = 'first'\nguid = '${crypto.randomUUID()}'\ntitle = 'Private Episode title'\ndescription = 'Private description'\npublished_at = '2026-10-01T12:00:00Z'\n`) }];
  const request = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    kind, show_id: "daily", expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}),
    payloads: contents.map((content) => ({ asset: content.asset, length_bytes: content.bytes.length, sha256: createHash("sha256").update(content.bytes).digest("hex") })) });
  const operation = await claimStageUpload(env, request);
  await beginStageUpload(env, operation);
  function putPayload(key: string, bytes: Uint8Array) { payloads.set(key, { bytes, size: bytes.length, etag: `payload-${++revision}` }); }
  for (const content of contents) putPayload(stagePayloadKey(request, content.asset as "show_metadata" | "cover_jpg" | "audio" | "episode_metadata"), content.bytes);
  return { ...base, env, bucket, payloads, bodyReads, putPayload, request, operation,
    settle: () => settleStageUpload(env, operation, { put_requests_settled: true, no_more_puts: true }),
    statusKey: `system/jobs/${operation.operationId}/status.toml`, progressKey: `system/jobs/${operation.operationId}/upload-progress.json` };
}

describe("M6 staging verification and admission completion", () => {
  test("Show, Episode metadata and streamed audio finish without publishing or copying private content", async () => {
    for (const asset of ["show", "audio", "episode_metadata"] as const) {
      const setup = await fixture(asset);
      await setup.settle();
      const before = new Map(setup.payloads);
      await runStageVerification(setup.env, setup.operation, "staged", { digest });
      const control = (await readShowControl(setup.env, "daily"))!.value;
      expect(control.owner).toBeUndefined();
      expect(control.lifecycle).toBe(asset === "show" ? "draft" : "active");
      expect(control.feed_generation).toBe(0);
      expect(control.last_finished_upload?.outcome).toBe("staged");
      expect(control.last_finished_upload?.operation_id).toBe(setup.operation.operationId);
      expect(setup.payloads).toEqual(before);
      expect(JSON.parse(setup.entries.get(setup.progressKey)!.data).verified_assets).toHaveLength(setup.request.payloads.length);
      const status = parseJobStatus(setup.entries.get(setup.statusKey)!.data);
      expect(status.state).toBe("completed");
      for (const [key, entry] of setup.entries) if (key.startsWith(`system/jobs/${setup.operation.operationId}/`)) {
        expect(entry.data).not.toContain("Private");
        expect(entry.data).not.toContain("owner@example.com");
      }
      const count = setup.writes.length;
      await runStageVerification(setup.env, setup.operation, "staged", { digest });
      expect(setup.writes).toHaveLength(count);
    }
  });

  test("verification and abort are forbidden while the client may still PUT", async () => {
    const setup = await fixture("audio");
    await expect(runStageVerification(setup.env, setup.operation, "staged", { digest })).rejects.toThrow("must settle");
    await expect(runStageVerification(setup.env, setup.operation, "aborted", { digest })).rejects.toThrow("must settle");
    expect(setup.bodyReads).toEqual([]);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("uploading");
  });

  test("explicit abort after settlement retains payloads and closes only this staging admission", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    const before = new Map(setup.payloads);
    await runStageVerification(setup.env, setup.operation, "aborted");
    expect(setup.bodyReads).toEqual([]);
    expect(setup.payloads).toEqual(before);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    expect((await readShowControl(setup.env, "daily"))?.value.last_finished_upload?.outcome).toBe("aborted");
    await expect(runStageVerification(setup.env, setup.operation, "staged", { digest })).rejects.toThrow("different outcome");
  });

  test("size/hash/image/schema failures keep admission held and retain only fixed diagnostics", async () => {
    for (const fault of ["size", "hash", "digest-error", "image", "metadata"] as const) {
      const setup = await fixture(fault === "image" || fault === "metadata" ? "show" : "audio", fault === "image" || fault === "metadata" ? fault : undefined);
      await setup.settle();
      if (fault === "size") setup.putPayload(stagePayloadKey(setup.request, "audio"), new Uint8Array(1));
      if (fault === "hash") setup.putPayload(stagePayloadKey(setup.request, "audio"), new Uint8Array(setup.request.payloads[0]!.length_bytes));
      const secret = "Private title owner@example.com Bearer secret";
      const checksum = fault === "digest-error" ? async () => { throw new Error(secret); } : digest;
      await expect(runStageVerification(setup.env, setup.operation, "staged", { digest: checksum })).rejects.toThrow();
      const control = (await readShowControl(setup.env, "daily"))!.value;
      expect(control.owner?.job_id).toBe(setup.operation.operationId);
      expect(control.owner?.verification_id).toBeUndefined();
      expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("retrying");
      expect(setup.entries.get(setup.statusKey)!.data).not.toContain(secret);
      expect(JSON.parse(setup.entries.get(setup.progressKey)!.data).reason_code).toBe("validation_failed");
      await runStageVerification(setup.env, setup.operation, "aborted");
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    }
  });

  test("live verification is exclusive until its streamed digest has settled", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const outcome = (async () => {
      try { await runStageVerification(setup.env, setup.operation, "staged", { digest: async (body, length) => {
        started.resolve(); await ended.promise; return digest(body, length);
      } }); return null; } catch (error) { return error; }
    })();
    await started.promise;
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.verification_id).toBeString();
    await expect(runStageVerification(setup.env, setup.operation, "aborted")).rejects.toThrow("still running");
    await expect(claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "show", action: "delete",
      expected_show_generation: 1, created_at: "2026-10-01T12:00:00Z" })).rejects.toThrow("unfinished");
    ended.resolve();
    expect(await outcome).toBeNull();
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("verification token acquisition response loss remains blocked, not force-recovered", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    let lose = true;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (lose && written && args[0] === "system/show-publications/daily.json" && args[1].includes('"verification_id"')) {
        lose = false; throw new Error("Verification acquisition response lost");
      }
      return written;
    } } } as never;
    await expect(runStageVerification(env, setup.operation, "staged", { digest })).rejects.toThrow("acquisition response lost");
    const before = (await readShowControl(setup.env, "daily"))!.value;
    expect(before.owner?.verification_id).toBeString();
    await expect(runStageVerification(setup.env, setup.operation, "aborted")).rejects.toThrow("still running");
    expect((await readShowControl(setup.env, "daily"))!.value).toEqual(before);
    expect(setup.bodyReads).toEqual([]);
  });

  test("verified/finished/status/release response loss recovers without publishing or replacing payloads", async () => {
    for (const fault of ["verified", "finished", "status", "release"] as const) {
      const setup = await fixture("audio");
      await setup.settle();
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const match = fault === "status" ? args[0] === setup.statusKey && args[1].includes('state = "completed"') :
          fault === "release" ? args[0] === "system/show-publications/daily.json" && args[1].includes('"last_finished_upload"') :
          args[0] === setup.progressKey && JSON.parse(args[1]).phase === fault;
        if (lose && written && match) { lose = false; throw new Error("Verification response lost"); }
        return written;
      } } } as never;
      if (fault === "release") await runStageVerification(env, setup.operation, "staged", { digest });
      else await expect(runStageVerification(env, setup.operation, "staged", { digest })).rejects.toThrow("response lost");
      await runStageVerification(env, setup.operation, "staged", { digest });
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readShowControl(setup.env, "daily"))?.value.last_finished_upload?.outcome).toBe("staged");
      expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("completed");
      expect(setup.payloads.size).toBe(1);
    }
  });

  test("completion replay never releases a later lifecycle owner", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    await runStageVerification(setup.env, setup.operation, "staged", { digest });
    const nextJob = crypto.randomUUID();
    await claimShowOperation(setup.env, { schema_version: 1, job_id: nextJob, show_id: "daily", kind: "show", action: "delete",
      expected_show_generation: 1, created_at: "2026-10-01T12:00:00Z" });
    const before = new Map(setup.entries);
    await runStageVerification(setup.env, setup.operation, "staged", { digest });
    expect(setup.entries).toEqual(before);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(nextJob);
  });

  test("only the verification token holder may return its token", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    const verification = await acquireStageVerification(setup.env, setup.operation);
    await expect(releaseStageVerification(setup.env, { ...verification, verificationId: crypto.randomUUID() })).rejects.toThrow("no longer owns");
    await releaseStageVerification(setup.env, verification);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.verification_id).toBeUndefined();
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.operation.operationId);
    const snapshot = await requireStageUpload(setup.env, setup.operation);
    expect((await readStageUploadProgress(setup.env, setup.operation, snapshot))?.value.client_settled).toBe(true);
  });

  test("published Show cover extension cannot be silently changed during staging", async () => {
    const setup = await fixture("show");
    const show = parseShowMetadata(SHOW_TEXT);
    await setup.bucket.put("system/shows/daily/show.toml", stringifyToml({ ...show, image_path: "cover.png" }));
    await setup.settle();
    await expect(runStageVerification(setup.env, setup.operation, "staged")).rejects.toThrow("cover extension");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.operation.operationId);
    await runStageVerification(setup.env, setup.operation, "aborted");
  });

  test("published Episode GUID and published_at remain immutable even for correctly hashed staging inputs", async () => {
    for (const fault of ["guid", "published_at"] as const) {
      const setup = await fixture("episode_metadata");
      const bytes = setup.payloads.get(stagePayloadKey(setup.request, "episode_metadata"))!.bytes;
      const staged = parseEpisodeDraft(new TextDecoder().decode(bytes));
      const current = episodeRevisionSchema.parse({ ...staged, ...(fault === "guid" ? { guid: crypto.randomUUID() } :
        { published_at: "2026-09-30T12:00:00Z" }), revision_id: crypto.randomUUID(),
        enclosure_url: `https://example.com/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`,
        content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-10-01T12:00:00Z" });
      await setup.bucket.put("public/episodes/daily/first/metadata.toml", stringifyToml(current));
      await setup.settle();
      await expect(runStageVerification(setup.env, setup.operation, "staged")).rejects.toThrow("must remain unchanged");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.operation.operationId);
    }
  });

  test("payload ETag changes after verification prevent admission release despite matching size", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    const key = stagePayloadKey(setup.request, "audio");
    await expect(runStageVerification(setup.env, setup.operation, "staged", { digest: async (body, length) => {
      const result = await digest(body, length);
      setup.putPayload(key, setup.payloads.get(key)!.bytes);
      return result;
    } })).rejects.toThrow("changed before completion");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.operation.operationId);
    expect((await readShowControl(setup.env, "daily"))?.value.last_finished_upload).toBeUndefined();
  });

  test("a failed verification-token return keeps admission and its token blocked", async () => {
    const setup = await fixture("audio");
    await setup.settle();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (args[0] === "system/show-publications/daily.json" && args[1].includes('"owner"') && !args[1].includes('"verification_id"')) {
        throw new Error("Verification token return unavailable");
      }
      return setup.bucket.put(...args);
    } } } as never;
    await expect(runStageVerification(env, setup.operation, "staged", { digest: async () => { throw new Error("Read unavailable"); } }))
      .rejects.toThrow("token return unavailable");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.verification_id).toBeString();
    await expect(runStageVerification(setup.env, setup.operation, "aborted")).rejects.toThrow("still running");
  });

  test("the Workers streaming digest path counts bytes and awaits pipe and digest failures", async () => {
    const previous = Object.getOwnPropertyDescriptor(crypto, "DigestStream");
    class TestDigestStream extends WritableStream<Uint8Array> {
      digest: Promise<ArrayBuffer>;
      constructor() {
        const hash = createHash("sha256");
        const result = Promise.withResolvers<ArrayBuffer>();
        super({ write(chunk) { hash.update(chunk); }, close() { result.resolve(Uint8Array.from(hash.digest()).buffer); },
          abort(reason) { result.reject(reason); } });
        this.digest = result.promise;
      }
    }
    Object.defineProperty(crypto, "DigestStream", { configurable: true, value: TestDigestStream });
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.from([1])); controller.enqueue(Uint8Array.from([2, 3])); controller.close();
    } });
    try {
      expect(await digestStageStream(stream(), 3)).toBe(createHash("sha256").update(Uint8Array.from([1, 2, 3])).digest("hex"));
      await expect(digestStageStream(stream(), 2)).rejects.toThrow("exceeds");
      await expect(digestStageStream(stream(), 4)).rejects.toThrow("ended before");
    } finally {
      if (previous) Object.defineProperty(crypto, "DigestStream", previous);
      else Reflect.deleteProperty(crypto, "DigestStream");
    }
  });
});
