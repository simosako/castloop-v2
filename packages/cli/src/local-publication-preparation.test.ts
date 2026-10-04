import { describe, expect, test } from "bun:test";
import { episodeDraftFromRevision, parseEpisodeRevision, publicationCommitKey, stringifyToml } from "@castloop/shared";
import type { StageUploadRequest } from "@castloop/shared";
import { prepareLocalPublication } from "./local-publication-preparation";
import { prepareLocalStagingUpload } from "./local-staging-preparation";
import { PublicationAdminClient } from "./publication-client";
import { runPublicationClaim, runPublicationCommit } from "./publication-operation";
import { StagingAdminClient } from "./staging-client";
import { createStagingOperationEffects, runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import { readShowControl } from "../../../src/lifecycle-control";
import { handleM6PublicationAdmin } from "../../../src/publication-admin";
import { consumeOwnedPublication } from "../../../src/publication-consumer";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture(mode: "show" | "episode" | "metadata" | "audio" = "show", audioFirst = false) {
  const setup = await stagingAdminFixture(mode === "show" ? "show" : "audio");
  const base = mode === "metadata" || mode === "audio" ? await setup.addEpisode("next", "active") : undefined;
  const root = mkdtempSync("/tmp/opencode/castloop-publication-preparation-");
  const directory = join(root, "daily");
  mkdirSync(directory, { mode: 0o700 });
  const metadataPath = join(directory, mode === "show" ? "show.toml" : "episode-next.toml");
  const episode = base ? { ...episodeDraftFromRevision(base), ...(mode === "metadata" ? { title: "Changed local title" } : {}) } :
    { schema_version: 1 as const, episode_id: "next", guid: crypto.randomUUID(), title: "Private title", description: "Private description",
      published_at: "2026-10-02T12:00:00Z" };
  writeFileSync(metadataPath, mode === "show" ? setup.text("system/shows/daily/show.toml") : stringifyToml(episode));
  writeFileSync(join(directory, "cover.jpg"), Uint8Array.from([255, 216, 255, 2]));
  const audioPath = join(directory, "audio.mp3");
  const frame = Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]);
  writeFileSync(audioPath, Buffer.concat(Array(50).fill(frame)));
  const stages: StageUploadRequest[] = [];
  const stageFiles: string[] = [];
  const selections = mode === "show" ? ["show"] : mode === "episode" ? (audioFirst ? ["audio", "episode_metadata"] : ["episode_metadata", "audio"]) :
    [mode === "metadata" ? "episode_metadata" : "audio"];
  const stagingClient = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    const response = await handleM6StagingAdmin(new Request(input, init), setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected staging route");
    return response;
  });
  for (const selection of selections) {
    const request = { schema_version: 1 as const, operation_id: crypto.randomUUID(), draft_job_id: setup.upload.draft_job_id,
      show_id: "daily", kind: mode === "show" ? "show" as const : "episode" as const,
      expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      ...(mode !== "show" ? { episode_id: "next", expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z" };
    const asset = selection === "show" ? { asset: "show" as const } : selection === "audio" ?
      { asset: "audio" as const, audio_path: "audio.mp3" } : { asset: "episode_metadata" as const };
    const prepared = await prepareLocalStagingUpload(root, setup.config, request, asset);
    try {
      const effects = { ...createStagingOperationEffects(setup.config, prepared.journal.load(), "private-secret", async (target, index) => {
        await prepared.sources.withPayload(index, async (body, consumed) => { await setup.bucket.put(target.key, body); consumed(); });
        return setup.readbacks(prepared.journal.load().upload, index + 1)[index]!;
      }, stagingClient), checkLocalInputs: prepared.sources.assertCurrent };
      await runStagingClaim(prepared.journal, effects);
      await runStagingBeginAndUpload(prepared.journal, effects);
      await runStagingSettle(prepared.journal, effects, { put_requests_settled: true, no_more_puts: true });
      await runStagingFinish(prepared.journal, effects);
      stages.push(prepared.journal.load().upload);
      stageFiles.push(join(root, ".castloop", "staging-uploads", setup.config.service_id, `${request.operation_id}.json`));
    } finally { await prepared.sources.dispose(); }
  }
  const request = { schema_version: 1 as const, job_id: setup.upload.draft_job_id, show_id: "daily",
    kind: mode === "show" ? "show" as const : "episode" as const, action: "publish" as const,
    expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
    ...(mode !== "show" ? { episode_id: "next", expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z" };
  const options = { stagedOperationIds: stages.map((stage) => stage.operation_id),
    ...(mode === "episode" || mode === "audio" ? { audioPath: "audio.mp3" } : {}), ...(base ? { baseRevision: base } : {}) };
  const actions: string[] = [];
  const sent: string[] = [];
  const env = { ...setup.env, CASTLOOP_QUEUE: { send: async (body: unknown) => { sent.push((body as { object: { key: string } }).object.key); } } };
  const client = new PublicationAdminClient(setup.config, "private-secret", async (input, init) => {
    const http = new Request(input, init);
    actions.push((await http.clone().json() as { action: string }).action);
    const response = await handleM6PublicationAdmin(http, env, setup.bindings);
    if (!response) throw new Error("Unexpected publication route");
    return response;
  });
  const file = join(root, ".castloop", "publication-jobs", setup.config.service_id, `${request.job_id}.json`);
  return { ...setup, root, directory, metadataPath, audioPath, stageFiles, stages, request, options, base, episode, env, client, actions, sent, file,
    prepare: () => prepareLocalPublication(root, setup.config, request, options, "private-secret", client),
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("prepare publication from acknowledged local staging journals", () => {
  for (const mode of ["show", "episode", "metadata", "audio"] as const) {
    test(`${mode} prepares without HTTP and publishes explicitly through the owned consumer`, async () => {
      const setup = await fixture(mode);
      try {
        const prepared = await setup.prepare();
        const state = prepared.journal.load();
        expect(state.phase).toBe("prepared");
        expect(state.publication.staged_uploads).toEqual([...setup.options.stagedOperationIds].sort());
        expect(state.publication.commit.job_id).toBe(setup.request.job_id);
        expect(setup.actions).toEqual([]);
        if (state.publication.commit.kind === "episode") {
          expect(state.publication.commit.committed_at).toBe(setup.request.created_at);
          expect(state.publication.commit.duration_seconds).toBe(mode === "metadata" ? undefined : 1);
          expect(state.publication.commit.base_revision_id).toBe(setup.base?.revision_id);
        }
        for (const value of ["Private description", "Private title", "Changed local title", "owner@example.com", "private-secret", setup.root]) {
          expect(readFileSync(setup.file, "utf8")).not.toContain(value);
        }
        const history = setup.base ? setup.text(`public/episodes/daily/next/revisions/${setup.base.revision_id}.toml`) : undefined;
        await runPublicationClaim(prepared.journal, prepared.effects);
        await runPublicationCommit(prepared.journal, prepared.effects);
        const key = publicationCommitKey(state.publication.commit);
        expect(setup.sent).toEqual([]);
        expect(await setup.bucket.head(key)).not.toBeNull();
        expect(await consumeOwnedPublication(setup.env, key, { async checkDeliveryGate() {}, async purge() {} })).toEqual({ state: "completed" });
        expect(setup.actions).toEqual(["claim", "status", "commit"]);
        if (mode !== "show") {
          const metadata = parseEpisodeRevision(setup.text("public/episodes/daily/next/metadata.toml"));
          expect(metadata.guid).toBe(setup.episode.guid);
          expect(metadata.published_at).toBe(setup.episode.published_at);
          if (setup.base) expect(setup.text(`public/episodes/daily/next/revisions/${setup.base.revision_id}.toml`)).toBe(history!);
          if (mode === "metadata") expect(new URL(metadata.enclosure_url).pathname).toBe(new URL(setup.base!.enclosure_url).pathname);
        }
      } finally { setup.dispose(); }
    });
  }

  test("audio-first staging and reversed input order produce the same frozen publication manifest", async () => {
    const setup = await fixture("episode", true);
    try {
      const first = await setup.prepare();
      const before = readFileSync(setup.file);
      const second = await prepareLocalPublication(setup.root, setup.config, setup.request,
        { ...setup.options, stagedOperationIds: [...setup.options.stagedOperationIds].reverse() }, "private-secret", setup.client);
      expect(second.journal.load()).toEqual(first.journal.load());
      expect(readFileSync(setup.file)).toEqual(before);
      expect(setup.actions).toEqual([]);
    } finally { setup.dispose(); }
  });

  test("stale metadata and media edits fail before publication journal creation", async () => {
    for (const changed of ["metadata", "audio"] as const) {
      const setup = await fixture("episode");
      try {
        const file = changed === "metadata" ? setup.metadataPath : setup.audioPath;
        writeFileSync(file, changed === "metadata" ? stringifyToml({ ...setup.episode, title: "Unstaged title" }) : "changed media");
        await expect(setup.prepare()).rejects.toThrow();
        expect(existsSync(setup.file)).toBe(false);
        expect(setup.actions).toEqual([]);
      } finally { setup.dispose(); }
    }
  });

  test("unfinished, aborted, missing and locked staging journals cannot authorize preparation", async () => {
    const setup = await fixture("show");
    try {
      const original = readFileSync(setup.stageFiles[0]!);
      writeFileSync(`${setup.stageFiles[0]}.lock`, "keep upload lock");
      await expect(setup.prepare()).rejects.toThrow("finished staged");
      expect(readFileSync(`${setup.stageFiles[0]}.lock`, "utf8")).toBe("keep upload lock");
      rmSync(`${setup.stageFiles[0]}.lock`);
      const state = JSON.parse(original.toString()) as Record<string, unknown>;
      const prepared = { schema_version: state.schema_version, identity: state.identity, upload: state.upload, phase: "prepared" };
      writeFileSync(setup.stageFiles[0]!, JSON.stringify(prepared));
      await expect(setup.prepare()).rejects.toThrow("finished staged");
      writeFileSync(setup.stageFiles[0]!, JSON.stringify({ ...state, finish_receipt: "aborted", put_outcome: "aborted",
        acknowledged_puts: 0, readback_receipts: [], reason_code: "put_failed" }));
      await expect(setup.prepare()).rejects.toThrow("finished staged");
      rmSync(setup.stageFiles[0]!);
      await expect(setup.prepare()).rejects.toThrow("finished staged");
      expect(existsSync(setup.file)).toBe(false);
      expect(setup.actions).toEqual([]);
    } finally { setup.dispose(); }
  });

  test("different targets, drafts, base identities and incomplete initial inputs are rejected", async () => {
    const setup = await fixture("episode");
    try {
      await expect(prepareLocalPublication(setup.root, setup.config, { ...setup.request, job_id: crypto.randomUUID() },
        setup.options, "private-secret", setup.client)).rejects.toThrow("differs");
      await expect(prepareLocalPublication(setup.root, setup.config, setup.request,
        { ...setup.options, stagedOperationIds: [setup.options.stagedOperationIds[0]!] }, "private-secret", setup.client)).rejects.toThrow();
      expect(setup.actions).toEqual([]);
      expect(existsSync(setup.file)).toBe(false);
    } finally { setup.dispose(); }
    const revision = await fixture("audio");
    try {
      await expect(prepareLocalPublication(revision.root, revision.config, revision.request,
        { ...revision.options, baseRevision: { ...revision.base!, guid: crypto.randomUUID() } }, "private-secret", revision.client)).rejects.toThrow("immutable identity");
      expect(existsSync(revision.file)).toBe(false);
    } finally { revision.dispose(); }
  });

  test("prepared jobs cannot be changed or reopened after claim and retained publication locks are preserved", async () => {
    const setup = await fixture("show");
    try {
      const prepared = await setup.prepare();
      const before = readFileSync(setup.file);
      await expect(prepareLocalPublication(setup.root, setup.config, { ...setup.request, created_at: "2026-10-02T12:00:01Z" },
        setup.options, "private-secret", setup.client)).rejects.toThrow("different frozen");
      expect(readFileSync(setup.file)).toEqual(before);
      writeFileSync(`${setup.file}.lock`, "keep publication lock");
      await expect(setup.prepare()).rejects.toThrow("cannot reopen");
      expect(readFileSync(`${setup.file}.lock`, "utf8")).toBe("keep publication lock");
      rmSync(`${setup.file}.lock`);
      await runPublicationClaim(prepared.journal, prepared.effects);
      await expect(setup.prepare()).rejects.toThrow("cannot reopen");
      expect(prepared.journal.load().phase).toBe("claimed");
      expect(setup.actions).toEqual(["claim"]);
    } finally { setup.dispose(); }
  });

  test("staging receipt changes after preparation are detected before claim or commit POST", async () => {
    for (const phase of ["prepared", "claimed"] as const) {
      const setup = await fixture("show");
      try {
        const prepared = await setup.prepare();
        if (phase === "claimed") await runPublicationClaim(prepared.journal, prepared.effects);
        writeFileSync(`${setup.stageFiles[0]}.lock`, "keep new upload lock");
        if (phase === "prepared") await expect(runPublicationClaim(prepared.journal, prepared.effects)).rejects.toThrow("staging records");
        else await expect(runPublicationCommit(prepared.journal, prepared.effects)).rejects.toThrow("staging records");
        expect(prepared.journal.load().phase).toBe(phase);
        expect(setup.actions).toEqual(phase === "prepared" ? [] : ["claim", "status"]);
        expect(readFileSync(`${setup.stageFiles[0]}.lock`, "utf8")).toBe("keep new upload lock");
      } finally { setup.dispose(); }
    }
  });
});
