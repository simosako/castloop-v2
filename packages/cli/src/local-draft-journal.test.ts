import { describe, expect, test } from "bun:test";
import { stringifyToml } from "@castloop/shared";
import { createLocalDraftJournal, readLocalDraft, rotateLocalDraft, validateLocalDraftState } from "./local-draft-journal";
import { prepareLocalPublication } from "./local-publication-preparation";
import { prepareLocalStagingUpload } from "./local-staging-preparation";
import { PublicationAdminClient } from "./publication-client";
import { runPublicationClaim, runPublicationCommit } from "./publication-operation";
import { StagingAdminClient } from "./staging-client";
import { createStagingOperationEffects, runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import { handleM6PublicationAdmin } from "../../../src/publication-admin";
import { readShowControl } from "../../../src/lifecycle-control";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture(episode = false) {
  const setup = await stagingAdminFixture(episode ? "audio" : "show");
  const root = mkdtempSync("/tmp/opencode/castloop-draft-journal-");
  const directory = join(root, "daily");
  mkdirSync(directory);
  writeFileSync(join(directory, "show.toml"), setup.text("system/shows/daily/show.toml"));
  writeFileSync(join(directory, "cover.jpg"), Uint8Array.from([255, 216, 255, 1]));
  writeFileSync(join(directory, "episode-next.toml"), stringifyToml({ schema_version: 1, episode_id: "next", guid: crypto.randomUUID(),
    title: "Private title", description: "Private description", published_at: "2026-10-02T12:00:00Z" }));
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  const target = episode ? { kind: "episode" as const, show_id: "daily", episode_id: "next" } : { kind: "show" as const, show_id: "daily" };
  const id = setup.upload.draft_job_id;
  const generation = (await readShowControl(setup.env, "daily"))!.value.generation;
  const journal = createLocalDraftJournal(root, setup.config, target, id);
  const file = join(root, ".castloop", "drafts", setup.config.service_id, episode ? "episode-daily--next.json" : "show-daily.json");
  const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    const response = await handleM6StagingAdmin(new Request(input, init), setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected staging route");
    return response;
  });
  const stage = async (asset: "show" | "episode_metadata" | "audio" = "show", draftId = id) => {
    const prepared = await prepareLocalStagingUpload(root, setup.config, { schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: draftId,
      ...target, expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      ...(episode ? { expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z" },
      asset === "audio" ? { asset, audio_path: "audio.mp3" } : { asset });
    const effects = { ...createStagingOperationEffects(setup.config, prepared.journal.load(), "private-secret", async (remote, index) => {
      await prepared.sources.withPayload(index, async (body, consumed) => { await setup.bucket.put(remote.key, body); consumed(); });
      return setup.readbacks(prepared.journal.load().upload, index + 1)[index]!;
    }, client), checkLocalInputs: prepared.sources.assertCurrent };
    return { ...prepared, effects, finish: async () => {
      await runStagingClaim(prepared.journal, effects);
      await runStagingBeginAndUpload(prepared.journal, effects);
      await runStagingSettle(prepared.journal, effects, { put_requests_settled: true, no_more_puts: true });
      await runStagingFinish(prepared.journal, effects);
    } };
  };
  return { ...setup, root, target, id, generation, journal, file, stage, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("durable target-local M6 draft identity", () => {
  test("keeps one identity across reopen and refuses a different job, service, base or target", async () => {
    const setup = await fixture();
    try {
      expect(createLocalDraftJournal(setup.root, setup.config, setup.target, setup.id).load()).toEqual(setup.journal.load());
      expect(() => createLocalDraftJournal(setup.root, setup.config, setup.target, crypto.randomUUID())).toThrow();
      expect(() => readLocalDraft(setup.root, { ...setup.config, worker_name: "other-worker" }, setup.target)).toThrow();
      expect(() => createLocalDraftJournal(setup.root, setup.config, setup.target, setup.id, crypto.randomUUID())).toThrow();
      const bytes = readFileSync(setup.file, "utf8");
      expect(bytes).not.toContain("Private title");
      expect(bytes).not.toContain("private-secret");
      expect(readLocalDraft(setup.root, setup.config, setup.target).remote_state_checked).toBe(false);
    } finally { setup.dispose(); }
  });

  test("attaches prepared uploads before HTTP, refuses unresolved replacement, preserves old finished journals", async () => {
    const setup = await fixture();
    const first = await setup.stage();
    const second = await setup.stage();
    try {
      const a = first.journal.load().upload.operation_id;
      const b = second.journal.load().upload.operation_id;
      await setup.journal.exclusively(async (editor) => { editor.attachUpload(a); editor.attachUpload(a); });
      await expect(setup.journal.exclusively(async (editor) => editor.attachUpload(b))).rejects.toThrow("unresolved");
      await setup.journal.exclusively(async (editor) => { await first.finish(); editor.attachUpload(b); });
      expect(setup.journal.load().uploads).toEqual([{ slot: "show", operation_id: b }]);
      expect(first.journal.load().finish_receipt).toBe("staged");
    } finally { await first.sources.dispose(); await second.sources.dispose(); setup.dispose(); }
  });

  for (const episode of [false, true]) {
    test(`${episode ? "Episode" : "Show"} freezes editing before claim and freezes identity only after an acknowledged commit`, async () => {
      const setup = await fixture(episode);
      const stages: Awaited<ReturnType<typeof setup.stage>>[] = [];
      try {
        for (const asset of episode ? ["audio", "episode_metadata"] as const : ["show"] as const) {
          const stage = await setup.stage(asset);
          stages.push(stage);
          await setup.journal.exclusively(async (editor) => { editor.attachUpload(stage.journal.load().upload.operation_id); await stage.finish(); });
        }
        const publicationClient = new PublicationAdminClient(setup.config, "private-secret", async (input, init) => {
          const response = await handleM6PublicationAdmin(new Request(input, init),
            { ...setup.env, CASTLOOP_QUEUE: { send: async () => {} } }, setup.bindings);
          if (!response) throw new Error("Unexpected publication route");
          return response;
        });
        const request = { schema_version: 1 as const, job_id: setup.id, ...setup.target, action: "publish" as const,
          expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
          ...(episode ? { expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z" };
        const publication = await prepareLocalPublication(setup.root, setup.config, request,
          { stagedOperationIds: stages.map((stage) => stage.journal.load().upload.operation_id), ...(episode ? { audioPath: "audio.mp3" } : {}) },
          "private-secret", publicationClient);
        await expect(setup.journal.exclusively(async (editor) => editor.acknowledgeCommit())).rejects.toThrow();
        await setup.journal.exclusively(async (editor) => { editor.preparePublication(); editor.preparePublication(); });
        expect(setup.journal.load().phase).toBe("publication_prepared");
        await expect(setup.journal.exclusively(async (editor) => editor.attachUpload(stages[0]!.journal.load().upload.operation_id))).rejects.toThrow("freezes");
        await setup.journal.exclusively(async (editor) => {
          await runPublicationClaim(publication.journal, publication.effects);
          expect(() => editor.acknowledgeCommit()).toThrow();
          await runPublicationCommit(publication.journal, publication.effects);
          editor.acknowledgeCommit();
          editor.acknowledgeCommit();
        });
        expect(setup.journal.load().phase).toBe("frozen");
        expect(setup.journal.load().publication_sha256).toBe(publication.journal.load().manifest_sha256);
        const frozen = setup.journal.load();
        const nextId = crypto.randomUUID();
        const nextBase = episode ? setup.id : undefined;
        const history = join(setup.root, ".castloop", "drafts", setup.config.service_id, "history");
        mkdirSync(history);
        const archive = join(history, `${setup.id}.json`);
        writeFileSync(archive, JSON.stringify({ ...frozen, publication_sha256: "0".repeat(64) }));
        await expect(rotateLocalDraft(setup.root, setup.config, setup.target, nextId, nextBase)).rejects.toThrow("history record");
        expect(setup.journal.load()).toEqual(frozen);
        writeFileSync(archive, JSON.stringify(frozen));
        const next = await rotateLocalDraft(setup.root, setup.config, setup.target, nextId, nextBase);
        expect(next.load().phase).toBe("editable");
        expect(next.load().uploads).toEqual([]);
        expect(next.load().base_revision_id).toBe(nextBase);
        expect(() => setup.journal.load()).toThrow("different");
        expect((await rotateLocalDraft(setup.root, setup.config, setup.target, nextId, nextBase)).load()).toEqual(next.load());
        expect(JSON.parse(readFileSync(archive, "utf8"))).toEqual(frozen);
        await expect(rotateLocalDraft(setup.root, setup.config, setup.target, setup.id)).rejects.toThrow();
        expect(publication.journal.load().phase).toBe("committed");
      } finally { for (const stage of stages) await stage.sources.dispose(); setup.dispose(); }
    });
  }

  test("retained locks block reopen and concurrent target edits, and escaped editors cannot write", async () => {
    const setup = await fixture();
    try {
      let escaped: Parameters<Parameters<typeof setup.journal.exclusively>[0]>[0] | undefined;
      await setup.journal.exclusively(async (editor) => {
        escaped = editor;
        expect(readLocalDraft(setup.root, setup.config, setup.target).lock_present).toBe(true);
        await expect(setup.journal.exclusively(async () => {})).rejects.toThrow();
      });
      expect(() => escaped!.preparePublication()).toThrow("exclusive");
      writeFileSync(`${setup.file}.lock`, "retained");
      expect(() => createLocalDraftJournal(setup.root, setup.config, setup.target, setup.id)).toThrow("retained");
      await expect(setup.journal.exclusively(async () => {})).rejects.toThrow();
      expect(readFileSync(`${setup.file}.lock`, "utf8")).toBe("retained");
    } finally { setup.dispose(); }
  });

  test("foreign upload identities and retained upload locks cannot become current", async () => {
    const setup = await fixture();
    const foreign = await setup.stage("show", crypto.randomUUID());
    const local = await setup.stage();
    try {
      await expect(setup.journal.exclusively(async (editor) => editor.attachUpload(foreign.journal.load().upload.operation_id))).rejects.toThrow("exact");
      const id = local.journal.load().upload.operation_id;
      writeFileSync(join(setup.root, ".castloop", "staging-uploads", setup.config.service_id, `${id}.json.lock`), "retained");
      await expect(setup.journal.exclusively(async (editor) => editor.attachUpload(id))).rejects.toThrow("lock");
      expect(setup.journal.load().uploads).toEqual([]);
    } finally { await foreign.sources.dispose(); await local.sources.dispose(); setup.dispose(); }
  });

  test("strict records reject duplicate slots, body fields, incompatible target and unjustified freeze", async () => {
    const setup = await fixture();
    try {
      const state = setup.journal.load();
      for (const invalid of [{ ...state, title: "private" }, { ...state, phase: "frozen" },
        { ...state, target: { ...state.target, episode_id: "next" } },
        { ...state, uploads: [{ slot: "show", operation_id: crypto.randomUUID() }, { slot: "show", operation_id: crypto.randomUUID() }] }]) {
        expect(() => validateLocalDraftState(invalid)).toThrow();
      }
    } finally { setup.dispose(); }
  });

  test("rotation refuses missing, editable, locked or invalid successor identities without changing the head", async () => {
    const setup = await fixture();
    try {
      const bytes = readFileSync(setup.file, "utf8");
      await expect(rotateLocalDraft(setup.root, setup.config, setup.target, crypto.randomUUID())).rejects.toThrow("frozen");
      await expect(rotateLocalDraft(setup.root, setup.config, { kind: "show", show_id: "missing" }, crypto.randomUUID())).rejects.toThrow("predecessor");
      await expect(rotateLocalDraft(setup.root, setup.config, setup.target, "invalid")).rejects.toThrow();
      await expect(rotateLocalDraft(setup.root, setup.config, setup.target, crypto.randomUUID(), "")).rejects.toThrow();
      writeFileSync(`${setup.file}.lock`, "retained");
      await expect(rotateLocalDraft(setup.root, setup.config, setup.target, crypto.randomUUID())).rejects.toThrow("lock");
      expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    } finally { setup.dispose(); }
  });

  test("a missing target head cannot recreate an identity retained in history or a publication lock", async () => {
    const setup = await fixture();
    try {
      const history = join(setup.root, ".castloop", "drafts", setup.config.service_id, "history");
      mkdirSync(history);
      writeFileSync(join(history, `${setup.id}.json`), readFileSync(setup.file));
      rmSync(setup.file);
      expect(() => createLocalDraftJournal(setup.root, setup.config, setup.target, setup.id)).toThrow("retained");
      const publicationDirectory = join(setup.root, ".castloop", "publication-jobs", setup.config.service_id);
      mkdirSync(publicationDirectory, { recursive: true });
      const nextId = crypto.randomUUID();
      writeFileSync(join(publicationDirectory, `${nextId}.json.lock`), "retained");
      expect(() => createLocalDraftJournal(setup.root, setup.config, setup.target, nextId)).toThrow("retained");
      expect(existsSync(setup.file)).toBe(false);
    } finally { setup.dispose(); }
  });

  test("symlink parents and files are refused without following or changing the target", async () => {
    const setup = await fixture();
    const other = mkdtempSync("/tmp/opencode/castloop-draft-symlink-");
    try {
      const linkRoot = join(other, "root");
      symlinkSync(setup.root, linkRoot);
      expect(() => readLocalDraft(linkRoot, setup.config, setup.target)).toThrow("real directories");
      const linkFile = join(other, "record");
      writeFileSync(linkFile, readFileSync(setup.file));
      rmSync(setup.file);
      symlinkSync(linkFile, setup.file);
      expect(() => readLocalDraft(setup.root, setup.config, setup.target)).toThrow();
      expect(existsSync(linkFile)).toBe(true);
    } finally { setup.dispose(); rmSync(other, { recursive: true, force: true }); }
  });
});
