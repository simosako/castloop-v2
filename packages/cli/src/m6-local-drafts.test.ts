import { describe, expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata, stringifyToml } from "@castloop/shared";
import { createM6LocalEpisodeDraft, createM6LocalShowDraft } from "./m6-local-drafts";
import { createShowRegistrationJournal } from "./show-registration-journal";
import { createShowRegistrationEffects, runShowRegistration } from "./show-registration-operation";
import { handleM6ShowRegistrationAdmin } from "../../../src/show-registration-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = await stagingAdminFixture("show");
  const root = mkdtempSync("/tmp/opencode/castloop-local-drafts-");
  const showId = "new-show";
  const request = { schema_version: 1 as const, service_id: setup.config.service_id, show_id: showId,
    reservation_id: crypto.randomUUID(), action: "reserve" as const };
  const journal = createShowRegistrationJournal(root, setup.config, request);
  let calls = 0;
  const effects = createShowRegistrationEffects(setup.config, "private-secret", async (input, init) => {
    calls++;
    const response = await handleM6ShowRegistrationAdmin(new Request(input, init), setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected route");
    return response;
  });
  const record = join(root, ".castloop", "show-registrations", setup.config.service_id, `${showId}.json`);
  return { ...setup, root, showId, request, journal, effects, record, calls: () => calls,
    register: () => runShowRegistration(journal, effects), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("M6 local drafts from durable Show registration receipts", () => {
  test("creates private editable TOML without legacy state, remote writes or journal changes", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      const before = readFileSync(setup.record);
      const file = await createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example/podcast");
      expect(parseShowMetadata(readFileSync(file, "utf8"))).toMatchObject({ show_id: setup.showId,
        site_url: "https://site.example/podcast", image_path: "cover.jpg" });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(setup.root, setup.showId)).mode & 0o777).toBe(0o700);
      const earliest = Date.now();
      const episode = await createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one");
      const source = readFileSync(episode, "utf8");
      const draft = parseEpisodeDraft(source);
      expect(draft.episode_id).toBe("episode-one");
      expect(draft.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Date.parse(draft.published_at)).toBeGreaterThanOrEqual(earliest - 1000);
      expect(Date.parse(draft.published_at)).toBeLessThanOrEqual(Date.now());
      expect(source).toMatch(/published_at\s*=\s*"/);
      expect(statSync(episode).mode & 0o777).toBe(0o600);
      expect(readFileSync(setup.record)).toEqual(before);
      expect(readFileSync(setup.record, "utf8")).not.toContain("site.example");
      expect(readFileSync(setup.record, "utf8")).not.toContain("owner@example.com");
      expect(setup.calls()).toBe(1);
      expect(existsSync(join(setup.root, ".castloop", "state.json"))).toBe(false);
      expect(existsSync(`${setup.record}.lock`)).toBe(false);
    } finally { setup.dispose(); }
  });

  test("missing, prepared and unknown registration outcomes cannot create any draft", async () => {
    const setup = await fixture();
    try {
      await expect(createM6LocalShowDraft(setup.root, setup.config, "missing-show", "https://site.example")).rejects.toThrow("receipt is required");
      for (const phase of ["prepared", "reserve_requested"] as const) {
        if (phase === "reserve_requested") await setup.journal.exclusively(async () => {
          setup.journal.save({ ...setup.journal.load(), phase });
        });
        const before = readFileSync(setup.record);
        await expect(createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example")).rejects.toThrow("receipt is required");
        await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")).rejects.toThrow("receipt is required");
        expect(readFileSync(setup.record)).toEqual(before);
        expect(existsSync(join(setup.root, setup.showId))).toBe(false);
      }
      expect(setup.calls()).toBe(0);
      expect(readdirSync(join(setup.root, ".castloop", "show-registrations", setup.config.service_id))).toEqual(["new-show.json"]);
    } finally { setup.dispose(); }
  });

  test("existing and partial Show directories are retained rather than adopted or overwritten", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      const directory = join(setup.root, setup.showId);
      mkdirSync(directory);
      await expect(createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example")).rejects.toThrow();
      expect(readdirSync(directory)).toEqual([]);
      writeFileSync(join(directory, "show.toml"), "keep user draft");
      await expect(createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example")).rejects.toThrow();
      expect(readFileSync(join(directory, "show.toml"), "utf8")).toBe("keep user draft");
    } finally { setup.dispose(); }
  });

  test("existing Episode bytes, GUID and date survive repeat and concurrent creation", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      await createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example");
      const results = await Promise.allSettled([1, 2].map(() => createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const file = join(setup.root, setup.showId, "episode-episode-one.toml");
      const before = readFileSync(file);
      await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")).rejects.toThrow();
      expect(readFileSync(file)).toEqual(before);
      expect(setup.calls()).toBe(1);
    } finally { setup.dispose(); }
  });

  test("foreign config and residual locks never authorize local creation or lock removal", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      await expect(createM6LocalShowDraft(setup.root, { ...setup.config, worker_name: "foreign-worker", workers_dev_base_url: "https://foreign-worker.example.workers.dev" }, setup.showId,
        "https://site.example")).rejects.toThrow("another service");
      writeFileSync(`${setup.record}.lock`, "keep unknown lock");
      const before = readFileSync(setup.record);
      await expect(createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example")).rejects.toThrow();
      expect(readFileSync(`${setup.record}.lock`, "utf8")).toBe("keep unknown lock");
      expect(readFileSync(setup.record)).toEqual(before);
      expect(existsSync(join(setup.root, setup.showId))).toBe(false);
    } finally { setup.dispose(); }
  });

  test("invalid site URL and slugs fail before file creation", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      for (const url of ["", "ftp://site.example", "https://user:secret@site.example", "https://site.example/#fragment"]) {
        await expect(createM6LocalShowDraft(setup.root, setup.config, setup.showId, url)).rejects.toThrow();
      }
      await expect(createM6LocalShowDraft(setup.root, setup.config, "../escape", "https://site.example")).rejects.toThrow();
      await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "../escape")).rejects.toThrow();
      expect(existsSync(join(setup.root, setup.showId))).toBe(false);
    } finally { setup.dispose(); }
  });

  test("legacy confirmation is not converted into a registration receipt and a symlink workspace is rejected", async () => {
    const setup = await fixture();
    try {
      writeFileSync(join(setup.root, ".castloop", "state.json"), JSON.stringify({
        shows: { "legacy-show": { confirmed: true, reservation_id: crypto.randomUUID() } },
      }));
      await expect(createM6LocalShowDraft(setup.root, setup.config, "legacy-show", "https://site.example")).rejects.toThrow("receipt is required");
      expect(existsSync(join(setup.root, "legacy-show"))).toBe(false);
      await setup.register();
      const alias = join(setup.root, "workspace-link");
      symlinkSync(setup.root, alias);
      await expect(createM6LocalShowDraft(alias, setup.config, setup.showId, "https://site.example")).rejects.toThrow("real directory");
      expect(existsSync(join(setup.root, setup.showId))).toBe(false);
    } finally { setup.dispose(); }
  });

  test("symlink Show parents, Show metadata and existing Episode paths are never followed", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      const elsewhere = join(setup.root, "elsewhere");
      mkdirSync(elsewhere);
      const directory = join(setup.root, setup.showId);
      symlinkSync(elsewhere, directory);
      await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")).rejects.toThrow("real directory");
      expect(readdirSync(elsewhere)).toEqual([]);
      rmSync(directory);
      await createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example");
      const show = join(directory, "show.toml");
      const original = readFileSync(show);
      const other = join(elsewhere, "show.toml");
      writeFileSync(other, original);
      rmSync(show);
      symlinkSync(other, show);
      await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")).rejects.toThrow();
      expect(readFileSync(other)).toEqual(original);
      rmSync(show);
      writeFileSync(show, original);
      symlinkSync(other, join(directory, "episode-episode-one.toml"));
      await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")).rejects.toThrow();
      expect(readFileSync(other)).toEqual(original);
    } finally { setup.dispose(); }
  });

  test("foreign, oversized, invalid UTF-8 and corrupt Show metadata block Episode creation", async () => {
    const setup = await fixture();
    try {
      await setup.register();
      const file = await createM6LocalShowDraft(setup.root, setup.config, setup.showId, "https://site.example");
      const metadata = parseShowMetadata(readFileSync(file, "utf8"));
      const invalid = [stringifyToml({ ...metadata, show_id: "foreign-show" }), Buffer.alloc(1000001, 97), Buffer.from([255]), "broken = ["];
      for (const value of invalid) {
        writeFileSync(file, value);
        await expect(createM6LocalEpisodeDraft(setup.root, setup.config, setup.showId, "episode-one")).rejects.toThrow();
        expect(readFileSync(file)).toEqual(Buffer.from(value));
        expect(existsSync(join(setup.root, setup.showId, "episode-episode-one.toml"))).toBe(false);
        expect(existsSync(`${setup.record}.lock`)).toBe(false);
      }
    } finally { setup.dispose(); }
  });
});
