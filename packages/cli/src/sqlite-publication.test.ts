import { afterEach, expect, spyOn, test } from "bun:test";
import * as localInput from "./local-input";
import * as audio from "./audio";
import { parseEpisodeDraft, stringifyToml } from "@castloop/shared";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { draftPreview } from "./draft-preview";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { readFileSync, readdirSync, writeFileSync, truncateSync } from "node:fs";
import { join } from "node:path";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function fixture(publishShow = true) {
  const f = await sqliteServiceFixture(); fixtures.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "worker source", f.options, { attempts: 2, delay: async () => {} });
  const options = { transport: f.transport, cloudflare: f.options };
  const command = (name: string, args: string[] = [], extra: SqliteCommandOptions = {}) => runSqliteCommand(f.root, f.config, name, args, { ...options, ...extra });
  await command("create-show", ["daily", "https://example.com"]);
  const directory = join(f.root, "daily"); writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  if (publishShow) await command("publish-show", ["daily"]);
  await command("create-episode", ["daily", "first"]);
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  return { ...f, directory, command };
}

test("one command publishes metadata and media with no staging, journal, operation RPC or body readback", async () => {
  const f = await fixture(); f.calls.length = 0;
  const result = await f.command("publish-episode", ["daily", "first", "audio.mp3"]);
  expect(result).toMatchObject({ result: "changed" });
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "GET" && call.path.includes("/objects/"))).toHaveLength(0);
  expect(f.calls.some((call) => /sqlite-operations|sqlite-publication\/jobs/.test(call.path))).toBe(false);
  expect([...f.entries.keys()].some((key) => key.startsWith("staging/") || /episode\.toml$|show\.toml$/.test(key))).toBe(false);
  const names = readdirSync(join(f.root, ".castloop"));
  expect(names).not.toContain("sqlite-drafts"); expect(names).not.toContain("sqlite-uploads"); expect(names.some((name) => name.startsWith("upload-inputs-"))).toBe(false);
});

test("Episode publication hashes and analyzes its MP3 once before PUT", async () => {
  const f = await fixture();
  const inspect = spyOn(localInput, "inspectLocalAsset"), analyze = spyOn(audio, "analyzeAudio");
  try {
    expect(await f.command("publish-episode", ["daily", "first", "audio.mp3"])).toMatchObject({ result: "changed" });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
  } finally { inspect.mockRestore(); analyze.mockRestore(); }
});

test("initial Episode requires MP3 while metadata-only updates reuse the saved audio", async () => {
  const f = await fixture();
  await expect(f.command("publish-episode", ["daily", "first"])).rejects.toThrow("audio");
  await f.command("publish-episode", ["daily", "first", "audio.mp3"]);
  const old = f.content.episodes("daily")[0]!;
  const file = join(f.directory, "episode-first.toml"), metadata = parseEpisodeDraft(readFileSync(file, "utf8"));
  writeFileSync(file, stringifyToml({ ...metadata, title: "Changed metadata" })); f.calls.length = 0;
  expect(await f.command("publish-episode", ["daily", "first"])).toMatchObject({ result: "changed" });
  expect(f.content.episodes("daily")[0]).toMatchObject({ title: "Changed metadata", enclosure_url: old.enclosure_url, guid: old.guid, published_at: old.published_at });
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("unchanged media with edited metadata uploads nothing; changed media PUTs once", async () => {
  const f = await fixture();
  writeFileSync(join(f.directory, "show.toml"), readFileSync(join(f.directory, "show.toml"), "utf8").replace('title = "daily"', 'title = "Edited show"'));
  f.calls.length = 0;
  expect(await f.command("publish-show", ["daily"])).toMatchObject({ result: "changed" });
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);

  await f.command("publish-episode", ["daily", "first", "audio.mp3"]);
  const file = join(f.directory, "episode-first.toml");
  writeFileSync(file, stringifyToml({ ...parseEpisodeDraft(readFileSync(file, "utf8")), title: "Changed metadata" }));
  f.calls.length = 0;
  expect(await f.command("publish-episode", ["daily", "first", "audio.mp3"])).toMatchObject({ result: "changed" });
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);

  writeFileSync(join(f.directory, "cover.jpg"), Buffer.from([255, 216, 255, 9]));
  f.calls.length = 0;
  await f.command("publish-show", ["daily"]);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);

  writeFileSync(join(f.directory, "audio.mp3"), Buffer.concat([readFileSync(join(f.directory, "audio.mp3")),
    Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)])]));
  f.calls.length = 0;
  await f.command("publish-episode", ["daily", "first", "audio.mp3"]);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("a lost publication after media placement re-PUTs the same media key", async () => {
  const f = await fixture(false); f.calls.length = 0;
  let lost = true;
  const transport: typeof f.transport = async (input, init) => {
    if (lost && init?.method === "POST" && String(input).endsWith("/publish")) { lost = false; throw new Error("Lost publication request"); }
    return f.transport(input, init);
  };
  await expect(f.command("publish-show", ["daily"], { transport })).rejects.toThrow("outcome is unknown");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
  f.calls.length = 0;
  expect(await f.command("publish-show", ["daily"])).toMatchObject({ result: "changed" });
  const puts = f.calls.filter((call) => call.method === "PUT");
  expect(puts).toHaveLength(1);
  expect([...f.entries.keys()].filter((key) => key.includes("/covers/"))).toHaveLength(1);
});

test("local preview never networks or places media; remote preview binds the base and input", async () => {
  const f = await fixture(false); f.calls.length = 0;
  const local = await draftPreview(f.root, f.config, { kind: "show", show_id: "daily" }, { mode: "local" });
  expect(local.remote_readiness).toBe("not_checked"); expect(f.calls).toHaveLength(0);
  const preview = await f.command("preview-show", ["daily"]) as { input_fingerprint: string };
  expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
  writeFileSync(join(f.directory, "show.toml"), readFileSync(join(f.directory, "show.toml"), "utf8").replace('title = "daily"', 'title = "Edited"'));
  f.calls.length = 0;
  await expect(f.command("publish-show", ["daily"], { expectedPreview: preview.input_fingerprint })).rejects.toThrow("changed");
  expect(f.calls.some((call) => call.method === "PUT" || call.method === "POST")).toBe(false);
});

test("lost publication response can be resolved by rerunning the same approved inputs", async () => {
  const f = await fixture();
  const preview = await f.command("preview-episode", ["daily", "first", "audio.mp3"]) as { input_fingerprint: string };
  f.faults.afterPublish = async () => { f.faults.afterPublish = undefined; throw new Error("Lost response"); };
  await expect(f.command("publish-episode", ["daily", "first", "audio.mp3"], { expectedPreview: preview.input_fingerprint })).rejects.toThrow("outcome is unknown");
  const revision = f.content.episodes("daily")[0]!.revision_id; f.calls.length = 0;
  expect(await f.command("publish-episode", ["daily", "first", "audio.mp3"], { expectedPreview: preview.input_fingerprint })).toMatchObject({ result: "unchanged", revision_id: revision });
  expect(f.content.listEpisodeRevisions("daily", "first", f.config.public_base_url).items).toHaveLength(1);
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("a bad PUT receipt prevents the publication request", async () => {
  const f = await fixture(false); f.calls.length = 0;
  const transport: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    return init?.method === "PUT" ? Response.json({ success: true, result: { key: "wrong", size: 4 } }) : response;
  };
  await expect(f.command("publish-show", ["daily"], { cloudflare: { ...f.options, transport } })).rejects.toThrow("key or size");
  expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
  expect(f.calls.some((call) => call.path.endsWith("/publish"))).toBe(false);
});

test("local edits during placement prevent publication without replacing the captured request", async () => {
  const f = await fixture(false), file = join(f.directory, "show.toml"); f.calls.length = 0;
  const transport: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    if (init?.method === "PUT") writeFileSync(file, readFileSync(file, "utf8").replace('title = "daily"', 'title = "Edited"'));
    return response;
  };
  await expect(f.command("publish-show", ["daily"], { cloudflare: { ...f.options, transport } })).rejects.toThrow("changed");
  expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
  expect(f.calls.some((call) => call.path.endsWith("/publish"))).toBe(false);
});

test("oversized MP3 is rejected before placement or publication", async () => {
  const f = await fixture(); truncateSync(join(f.directory, "audio.mp3"), 300_000_001); f.calls.length = 0;
  await expect(f.command("publish-episode", ["daily", "first", "audio.mp3"])).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("removed staging and job commands cannot perform remote mutations", async () => {
  const f = await fixture(); f.calls.length = 0;
  for (const name of ["update-show", "update-episode", "update-episode-audio", "job-status", "operation-list", "progress", "watch"]) {
    await expect(f.command(name, ["daily"])).rejects.toThrow("not implemented");
  }
  expect(f.calls).toHaveLength(0);
});
