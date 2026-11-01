import { expect, test } from "bun:test";
import { parseEpisodeDraft, stringifyToml } from "@castloop/shared";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { forwardLoopback, loopbackTarget } from "./test-support/loopback";
import { TEST_COVER_JPEG, TEST_MP3 } from "./test-support/media";
import { sqliteServiceFixture, TEST_WAIT } from "./test-support/sqlite-service";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = join(import.meta.dir, "index.ts");
const preload = fileURLToPath(new URL("./test-support/sqlite-cli-preload.ts", import.meta.url).href);
const reviewPrompt = 'Type "publish" to confirm this publication';
const futurePrompt = 'Type "publish now" to continue';

async function fixture(publishShow: boolean) {
  const f = await sqliteServiceFixture();
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "worker source", f.options, TEST_WAIT);
  const command = (name: string, args: string[]) => runSqliteCommand(f.root, f.config, name, args,
    { transport: f.transport, cloudflare: f.options });
  await command("create-show", ["daily", "https://example.com"]);
  const directory = join(f.root, "daily");
  writeFileSync(join(directory, "cover.jpg"), TEST_COVER_JPEG);
  writeFileSync(join(directory, "audio.mp3"), TEST_MP3);
  if (publishShow) await command("publish-show", ["daily"]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = loopbackTarget(request);
    return target ? forwardLoopback(request, target, f.transport) : new Response(null, { status: 400 });
  } });
  const env = { PATH: "", HOME: process.env.HOME, CLOUDFLARE_ACCOUNT_ID: f.config.account_id,
    CLOUDFLARE_API_TOKEN: "private-token", CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}` };
  return { f, command, directory, env, close() { server.stop(true); f.close(); } };
}

type Answer = { prompt: string; input: string; before?: () => void | Promise<void> };

async function terminalCommand(cwd: string, env: Record<string, string | undefined>, args: string[], answers: Answer[] = []) {
  let output = "", position = 0, pending = false, failure: unknown, timedOut = false;
  const child = Bun.spawn([process.execPath, "--preload", preload, entrypoint, ...args], { cwd, env, terminal: {
    data(terminal, data) {
      output += data.toString();
      const answer = answers[position];
      if (!pending && answer && output.includes(answer.prompt)) {
        position += 1; pending = true;
        Promise.resolve().then(() => answer.before?.()).then(() => { terminal.write(answer.input); pending = false; })
          .catch((error: unknown) => { failure = error; child.kill(); });
      }
    },
  } });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
  try {
    const code = await child.exited;
    if (failure) throw failure;
    expect(timedOut).toBe(false);
    return { code, output, answers: position };
  } finally { clearTimeout(timeout); child.terminal?.close(); }
}

function hasMutation(calls: Array<{ method: string; path: string }>): boolean {
  return calls.some((call) => call.method === "PUT" || call.method === "POST" || call.method === "DELETE");
}

if (process.platform !== "win32") test("review requires a terminal and publishes only after explicit Show and Episode confirmation", async () => {
  const setup = await fixture(false), { f, directory, env, command } = setup;
  try {
    f.calls.length = 0;
    for (const args of [["publish-show", "daily", "--review", "--json"], ["publish-episode", "first", "--show", "daily", "--review", "--json"]]) {
      const result = Bun.spawnSync([process.execPath, "--preload", preload, entrypoint, ...args],
        { cwd: f.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, error: { code: "interactive_required", outcome: "not_started" } });
    }
    const noTerminal = Bun.spawnSync([process.execPath, "--preload", preload, entrypoint, "publish-show", "daily", "--review"],
      { cwd: f.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(noTerminal.exitCode).toBe(1);
    expect(noTerminal.stderr.toString()).toContain("requires an interactive terminal");
    const noninteractive = await terminalCommand(f.root, env, ["publish-show", "daily", "--review", "--non-interactive"]);
    expect(noninteractive.code).toBe(1);
    expect(noninteractive.output).toContain("requires an interactive terminal");
    expect(f.calls).toHaveLength(0);

    const staleHash = await terminalCommand(f.root, env, ["publish-show", "daily", "--review", "--expect-preview", "a".repeat(64)]);
    expect(staleHash.code).toBe(1);
    expect(staleHash.output).toContain("Publication inputs or reviewed base changed; preview again");
    expect(staleHash.output).not.toContain(reviewPrompt);
    expect(hasMutation(f.calls)).toBe(false);

    f.calls.length = 0;
    const refused = await terminalCommand(f.root, env, ["publish-show", "daily", "--review"], [{ prompt: reviewPrompt, input: "\n" }]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Publication was not confirmed");
    expect(refused.output).toContain(`"workspace": "${f.root}"`);
    expect(refused.output).toContain('"service_id": "service"');
    expect(refused.output).toContain('"show_id": "daily"');
    expect(refused.output).toContain('"field": "title"');
    expect(refused.output).toContain('"candidate": "daily"');
    expect(refused.output).toContain(join(directory, "cover.jpg"));
    expect(hasMutation(f.calls)).toBe(false);
    expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");

    f.calls.length = 0;
    const eof = await terminalCommand(f.root, env, ["publish-show", "daily", "--review"], [{ prompt: reviewPrompt, input: "\x04" }]);
    expect(eof.code).toBe(1);
    expect(hasMutation(f.calls)).toBe(false);

    const showPreview = await command("preview-show", ["daily"]) as { input_fingerprint: string };
    f.calls.length = 0;
    const show = await terminalCommand(f.root, env, ["publish-show", "daily", "--review", "--expect-preview", showPreview.input_fingerprint],
      [{ prompt: reviewPrompt, input: "publish\n" }]);
    expect(show.code).toBe(0);
    expect(show.output).toContain('"result": "changed"');
    expect(f.content.inspect("daily").show?.lifecycle).toBe("published");

    await command("create-episode", ["daily", "first"]);
    f.calls.length = 0;
    const episode = await terminalCommand(directory, env, ["publish-episode", "first", "audio.mp3", "--review"],
      [{ prompt: reviewPrompt, input: "publish\n" }]);
    expect(episode.code).toBe(0);
    expect(episode.output).toContain('"episode_id": "first"');
    expect(episode.output).toContain(join(directory, "audio.mp3"));
    expect(episode.output).toContain('"result": "changed"');
    expect(f.content.episodes("daily")).toHaveLength(1);

    f.calls.length = 0;
    const unchanged = await terminalCommand(directory, env, ["publish-episode", "first", "audio.mp3", "--review"],
      [{ prompt: reviewPrompt, input: "publish\n" }]);
    expect(unchanged.code).toBe(0);
    expect(unchanged.output).toContain('"unchanged": true');
    expect(unchanged.output).toContain('"result": "unchanged"');
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  } finally { setup.close(); }
}, 90000);

if (process.platform !== "win32") test("review rejects changed inputs, configuration, and remote base before placing media", async () => {
  const setup = await fixture(true), { f, command, directory, env } = setup;
  try {
    await command("create-episode", ["daily", "first"]);
    const episodeFile = join(directory, "episode-first.toml"), showFile = join(directory, "show.toml");
    f.calls.length = 0;
    const changedInput = await terminalCommand(directory, env, ["publish-episode", "first", "audio.mp3", "--review"], [{
      prompt: reviewPrompt, input: "publish\n", before() {
        const current = parseEpisodeDraft(readFileSync(episodeFile, "utf8"));
        writeFileSync(episodeFile, stringifyToml({ ...current, title: "Changed after review" }));
      },
    }]);
    expect(changedInput.code).toBe(1);
    expect(changedInput.output).toContain("Publication inputs or reviewed base changed; preview again");
    expect(hasMutation(f.calls)).toBe(false);

    f.calls.length = 0;
    let callsAtConfigChange = 0;
    const changedConfig = await terminalCommand(directory, env, ["publish-episode", "first", "audio.mp3", "--review"], [{
      prompt: reviewPrompt, input: "publish\n", before() {
        writeFileSync(join(f.root, "castloop.toml"), stringifyToml({ ...f.config, bucket_name: "different-private-bucket" }));
        callsAtConfigChange = f.calls.length;
      },
    }]);
    expect(changedConfig.code).toBe(1);
    expect(changedConfig.output).toContain("Service configuration changed after review; preview again");
    expect(hasMutation(f.calls)).toBe(false);
    expect(f.calls).toHaveLength(callsAtConfigChange);
    writeFileSync(join(f.root, "castloop.toml"), stringifyToml(f.config));

    f.calls.length = 0;
    let afterOtherUpdate = 0;
    const changedBase = await terminalCommand(directory, env, ["publish-episode", "first", "audio.mp3", "--review"], [{
      prompt: reviewPrompt, input: "publish\n", async before() {
        writeFileSync(showFile, readFileSync(showFile, "utf8").replace('title = "daily"', 'title = "Updated elsewhere"'));
        await command("publish-show", ["daily"]);
        afterOtherUpdate = f.calls.length;
      },
    }]);
    expect(changedBase.code).toBe(1);
    expect(changedBase.output).toContain("Publication inputs or reviewed base changed; preview again");
    expect(hasMutation(f.calls.slice(afterOtherUpdate))).toBe(false);
    expect(f.content.episodes("daily")).toHaveLength(0);
  } finally { setup.close(); }
}, 90000);

if (process.platform !== "win32") test("review keeps the separate confirmation for immediate publication with a future date", async () => {
  const setup = await fixture(true), { f, command, directory, env } = setup;
  try {
    await command("create-episode", ["daily", "future"]);
    const file = join(directory, "episode-future.toml"), draft = parseEpisodeDraft(readFileSync(file, "utf8"));
    writeFileSync(file, stringifyToml({ ...draft, published_at: "2099-01-02T10:00:00Z" }));
    f.calls.length = 0;
    const refused = await terminalCommand(directory, env, ["publish-episode", "future", "audio.mp3", "--review"], [
      { prompt: reviewPrompt, input: "publish\n" }, { prompt: futurePrompt, input: "\n" },
    ]);
    expect(refused.code).toBe(1);
    expect(refused.answers).toBe(2);
    expect(refused.output).toContain("Immediate publication starts now");
    expect(hasMutation(f.calls)).toBe(false);

    f.calls.length = 0;
    const eof = await terminalCommand(directory, env, ["publish-episode", "future", "audio.mp3", "--review"], [
      { prompt: reviewPrompt, input: "publish\n" }, { prompt: futurePrompt, input: "\x04" },
    ]);
    expect(eof.code).toBe(1);
    expect(hasMutation(f.calls)).toBe(false);

    f.calls.length = 0;
    const changedAtFuturePrompt = await terminalCommand(directory, env, ["publish-episode", "future", "audio.mp3", "--review"], [
      { prompt: reviewPrompt, input: "publish\n" }, { prompt: futurePrompt, input: "publish now\n", before() {
        const current = parseEpisodeDraft(readFileSync(file, "utf8"));
        writeFileSync(file, stringifyToml({ ...current, title: "Changed during date confirmation" }));
      } },
    ]);
    expect(changedAtFuturePrompt.code).toBe(1);
    expect(changedAtFuturePrompt.output).toContain("Publication inputs or reviewed base changed; preview again");
    expect(hasMutation(f.calls)).toBe(false);

    f.calls.length = 0;
    const accepted = await terminalCommand(directory, env, ["publish-episode", "future", "audio.mp3", "--review"], [
      { prompt: reviewPrompt, input: "publish\n" }, { prompt: futurePrompt, input: "publish now\n" },
    ]);
    expect(accepted.code).toBe(0);
    expect(accepted.answers).toBe(2);
    expect(accepted.output).toContain('"result": "changed"');
    expect(f.content.episodes("daily")).toHaveLength(1);

    await command("create-episode", ["daily", "future-explicit"]);
    const explicitFile = join(directory, "episode-future-explicit.toml"), explicitDraft = parseEpisodeDraft(readFileSync(explicitFile, "utf8"));
    writeFileSync(explicitFile, stringifyToml({ ...explicitDraft, published_at: "2099-01-03T10:00:00Z" }));
    const explicit = await terminalCommand(directory, env,
      ["publish-episode", "future-explicit", "audio.mp3", "--review", "--allow-future-published-at"],
      [{ prompt: reviewPrompt, input: "publish\n" }]);
    expect(explicit.code).toBe(0);
    expect(explicit.answers).toBe(1);
    expect(explicit.output).toContain('"result": "changed"');
  } finally { setup.close(); }
}, 90000);
