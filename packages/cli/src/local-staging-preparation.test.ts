import { describe, expect, test } from "bun:test";
import { parseShowMetadata, stringifyToml } from "@castloop/shared";
import { createStagingOperationEffects, runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import { StagingAdminClient } from "./staging-client";
import { prepareLocalStagingUpload } from "./local-staging-preparation";
import type { LocalStagingSelection, PreparedLocalStagingUpload } from "./local-staging-preparation";
import { createStagingRestPut } from "./staging-rest";
import { inspectLocalStagingSource } from "./staging-sources";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture(kind: "show" | "audio" | "episode_metadata" = "show") {
  const setup = await stagingAdminFixture(kind);
  const root = mkdtempSync("/tmp/opencode/castloop-staging-preparation-");
  const directory = join(root, "daily");
  mkdirSync(directory, { mode: 0o700 });
  const showPath = join(directory, "show.toml");
  writeFileSync(showPath, setup.text("system/shows/daily/show.toml"));
  const episodePath = join(directory, "episode-next.toml");
  writeFileSync(episodePath, stringifyToml({ schema_version: 1, episode_id: "next", guid: crypto.randomUUID(),
    title: "Private title", description: "Private description", published_at: "2026-10-02T12:00:00Z" }));
  const coverPath = join(directory, "cover.jpg");
  writeFileSync(coverPath, Uint8Array.from([255, 216, 255, 2]));
  const audioPath = join(directory, "audio.mp3");
  const frame = Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]);
  writeFileSync(audioPath, Buffer.concat(Array(50).fill(frame)));
  const upload = setup.upload;
  const request = { schema_version: upload.schema_version, operation_id: upload.operation_id, draft_job_id: upload.draft_job_id,
    show_id: upload.show_id, kind: upload.kind, expected_show_generation: upload.expected_show_generation, created_at: upload.created_at,
    ...(upload.episode_id ? { episode_id: upload.episode_id, expected_episode_generation: upload.expected_episode_generation } : {}) };
  const selection: LocalStagingSelection = kind === "show" ? { asset: "show" } : kind === "audio" ?
    { asset: "audio", audio_path: "audio.mp3" } : { asset: "episode_metadata" };
  const sessions: PreparedLocalStagingUpload[] = [];
  return { ...setup, root, directory, showPath, episodePath, coverPath, audioPath, request, selection, sessions,
    prepare: async () => {
      const prepared = await prepareLocalStagingUpload(root, setup.config, request, selection);
      sessions.push(prepared);
      return prepared;
    }, dispose: async () => {
      for (const session of sessions) await session.sources.dispose();
      rmSync(root, { recursive: true, force: true });
    } };
}

describe("prepare M6 staging requests from current local drafts", () => {
  for (const kind of ["show", "episode_metadata", "audio"] as const) {
    test(`${kind} derives exact inputs, persists only the manifest and finishes through existing single-PUT runner`, async () => {
      const setup = await fixture(kind);
      try {
        const prepared = await setup.prepare();
        const state = prepared.journal.load();
        expect(state.phase).toBe("prepared");
        expect(state.upload.operation_id).toBe(setup.request.operation_id);
        expect(state.upload.draft_job_id).toBe(setup.request.draft_job_id);
        expect(prepared.durationSeconds).toBe(kind === "audio" ? 1 : undefined);
        const sources = kind === "show" ? [setup.showPath, setup.coverPath] : kind === "audio" ? [setup.audioPath] : [setup.episodePath];
        for (let index = 0; index < sources.length; index++) {
          const bytes = readFileSync(sources[index]!);
          expect(state.upload.payloads[index]).toMatchObject({ length_bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex") });
        }
        const record = join(setup.root, ".castloop", "staging-uploads", setup.config.service_id, `${setup.request.operation_id}.json`);
        const before = sources.map((source) => readFileSync(source));
        for (const value of ["Private description", "Private title", "owner@example.com", "private-secret", setup.root]) {
          expect(readFileSync(record, "utf8")).not.toContain(value);
        }
        const calls: string[] = [];
        const rest = createStagingRestPut(setup.config, prepared.sources, { accountId: setup.config.account_id, apiToken: "fake-token",
          transport: async (input, init) => {
            const url = new URL(String(input));
            const key = url.pathname.split("/objects/")[1]!;
            calls.push(init?.method ?? "GET");
            if (init?.method === "PUT") {
              const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
              const object = (await setup.bucket.put(key, bytes))!;
              return Response.json({ success: true, result: { key, size: object.size, etag: object.etag, version: object.version } });
            }
            const object = await setup.bucket.get(key);
            if (!object) return new Response(null, { status: 404 });
            return new Response(object.bytes, { headers: { ETag: `"${object.etag}"` } });
          } });
        const actions: string[] = [];
        const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
          const request = new Request(input, init);
          actions.push((await request.clone().json() as { action: string }).action);
          const response = await handleM6StagingAdmin(request, setup.env, setup.bindings);
          if (!response) throw new Error("Unexpected route");
          return response;
        });
        const effects = { ...createStagingOperationEffects(setup.config, state, "private-secret", rest, client), checkLocalInputs: prepared.sources.assertCurrent };
        await runStagingClaim(prepared.journal, effects);
        expect(await runStagingBeginAndUpload(prepared.journal, effects)).toBe("staged");
        await runStagingSettle(prepared.journal, effects, { put_requests_settled: true, no_more_puts: true });
        await runStagingFinish(prepared.journal, effects);
        expect(prepared.journal.load()).toMatchObject({ phase: "finished", finish_receipt: "staged" });
        expect(calls).toEqual(sources.flatMap(() => ["PUT", "GET"]));
        expect(actions).not.toContain("commit");
        expect(sources.map((source) => readFileSync(source))).toEqual(before);
      } finally { await setup.dispose(); }
    });
  }

  test("PNG/JPEG extension and signature are checked before any journal is created", async () => {
    const setup = await fixture();
    try {
      writeFileSync(setup.coverPath, "not an image");
      await expect(setup.prepare()).rejects.toThrow("signature");
      expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
      const show = parseShowMetadata(readFileSync(setup.showPath, "utf8"));
      writeFileSync(setup.showPath, stringifyToml({ ...show, image_path: "cover.png" }));
      writeFileSync(join(setup.directory, "cover.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      const prepared = await setup.prepare();
      expect(prepared.sources.upload.payloads.map((payload) => payload.asset)).toEqual(["show_metadata", "cover_png"]);
      expect(prepared.coverPath).toBe(join(setup.directory, "cover.png"));
    } finally { await setup.dispose(); }
  });

  test("foreign metadata, invalid MP3 and oversized inputs fail before snapshots or journals", async () => {
    for (const invalid of ["foreign", "mp3", "size"] as const) {
      const setup = await fixture("audio");
      try {
        if (invalid === "foreign") writeFileSync(setup.episodePath, readFileSync(setup.episodePath, "utf8").replace('episode_id = "next"', 'episode_id = "foreign"'));
        else if (invalid === "mp3") writeFileSync(setup.audioPath, "not an MP3");
        else truncateSync(setup.audioPath, 300000001);
        await expect(setup.prepare()).rejects.toThrow();
        expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
      } finally { await setup.dispose(); }
    }
  });

  test("stream inspection hashes all chunks and enforces cover and metadata budgets before preparing state", async () => {
    const setup = await fixture();
    try {
      const bytes = Buffer.alloc(150000, 37);
      bytes.set([255, 251, 144, 100]);
      writeFileSync(setup.audioPath, bytes);
      expect(await inspectLocalStagingSource(setup.audioPath, "audio")).toEqual({ prefix: bytes.subarray(0, 8),
        payload: { asset: "audio", length_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
      truncateSync(setup.coverPath, 5000001);
      await expect(setup.prepare()).rejects.toThrow();
      expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
      writeFileSync(setup.coverPath, Uint8Array.from([255, 216, 255, 2]));
      truncateSync(setup.showPath, 1000001);
      await expect(setup.prepare()).rejects.toThrow("size/type");
      expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
    } finally { await setup.dispose(); }
  });

  test("symlink inputs and a symlink Show parent are rejected without following their targets", async () => {
    const setup = await fixture();
    try {
      const original = readFileSync(setup.coverPath);
      rmSync(setup.coverPath);
      symlinkSync(setup.audioPath, setup.coverPath);
      await expect(setup.prepare()).rejects.toThrow();
      expect(readFileSync(setup.audioPath).length).toBe(20850);
      rmSync(setup.coverPath);
      writeFileSync(setup.coverPath, original);
      const alternate = join(setup.root, "another-show");
      symlinkSync(setup.directory, alternate);
      await expect(prepareLocalStagingUpload(setup.root, setup.config, { ...setup.request, show_id: "another-show" }, setup.selection)).rejects.toThrow("real directories");
      expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
    } finally { await setup.dispose(); }
  });

  test("only a still-prepared matching operation can be prepared again; changed content, requested phases and locks are retained", async () => {
    const setup = await fixture();
    try {
      const first = await setup.prepare();
      const record = join(setup.root, ".castloop", "staging-uploads", setup.config.service_id, `${setup.request.operation_id}.json`);
      const bytes = readFileSync(record);
      await first.sources.dispose();
      const second = await setup.prepare();
      expect(readFileSync(record)).toEqual(bytes);
      await second.sources.dispose();
      const cover = readFileSync(setup.coverPath);
      writeFileSync(setup.coverPath, Buffer.from([255, 216, 255, 3]));
      await expect(setup.prepare()).rejects.toThrow("different frozen inputs");
      expect(readFileSync(record)).toEqual(bytes);
      writeFileSync(setup.coverPath, cover);
      await first.journal.exclusively(async () => { first.journal.save({ ...first.journal.load(), phase: "claim_requested" }); });
      await expect(setup.prepare()).rejects.toThrow("cannot reopen");
      expect(first.journal.load().phase).toBe("claim_requested");
      writeFileSync(`${record}.lock`, "keep unknown lock");
      await expect(setup.prepare()).rejects.toThrow("cannot reopen");
      expect(readFileSync(`${record}.lock`, "utf8")).toBe("keep unknown lock");
      expect(readdirSync(join(setup.root, ".castloop")).filter((name) => name.startsWith("upload-inputs-"))).toEqual([]);
    } finally { await setup.dispose(); }
  });

  test("mismatched asset selection, equal IDs and foreign config never create a new upload operation", async () => {
    const setup = await fixture();
    try {
      await expect(prepareLocalStagingUpload(setup.root, setup.config, setup.request, { asset: "audio", audio_path: "audio.mp3" })).rejects.toThrow();
      await expect(prepareLocalStagingUpload(setup.root, setup.config, { ...setup.request, operation_id: setup.request.draft_job_id }, setup.selection)).rejects.toThrow();
      expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
      const prepared = await setup.prepare();
      const before = prepared.journal.load();
      await expect(prepareLocalStagingUpload(setup.root, { ...setup.config, worker_name: "foreign-worker", workers_dev_base_url: "https://foreign-worker.example.workers.dev" }, setup.request, setup.selection)).rejects.toThrow("another service");
      expect(prepared.journal.load()).toEqual(before);
    } finally { await setup.dispose(); }
  });
});
