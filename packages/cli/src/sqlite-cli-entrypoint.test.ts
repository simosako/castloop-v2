import { expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("formal CLI entrypoint initializes paused and publishes through the SQLite route under a local-only transport", async () => {
  const setup = await sqliteServiceFixture();
  const preload = fileURLToPath(new URL("./test-support/sqlite-cli-preload.ts", import.meta.url).href);
  const cli = fileURLToPath(new URL("./index.ts", import.meta.url).href);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = request.headers.get("X-Castloop-Test-Target");
    if (!target || !["api.cloudflare.com", "test-worker.example.workers.dev"].includes(new URL(target).hostname)) return new Response(null, { status: 400 });
    const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
    return setup.transport(target, { method: request.method, headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
  } });
  const environment = { ...process.env, CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}`,
    CLOUDFLARE_ACCOUNT_ID: setup.config.account_id, CLOUDFLARE_API_TOKEN: "private-token" };
  async function command(args: string[], cwd = setup.root) {
    const child = Bun.spawn([process.execPath, "--preload", preload, cli, ...args], { cwd, env: environment,
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Local CLI ${args[0]} failed: ${stderr}`);
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  try {
    expect(await command(["init", ".", "--operation-id", crypto.randomUUID()])).toMatchObject({ phase: "ready" });
    expect(setup.runtime.health().state).toBe("paused");
    await command(["service-resume", crypto.randomUUID()]);
    const show = Bun.spawn([process.execPath, "--preload", preload, cli, "create-show", "daily", "--site-url", "https://example.com/podcast"], {
      cwd: setup.root, env: environment, stdout: "pipe", stderr: "pipe" });
    const [showOutput, showError, showCode] = await Promise.all([new Response(show.stdout).text(), new Response(show.stderr).text(), show.exited]);
    expect(showCode, showError).toBe(0); expect(showOutput).toContain("show.toml");
    const directory = join(setup.root, "daily");
    writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
    await command(["update-show", "daily"]); expect(await command(["publish-show", "daily"])).toMatchObject({ state: "succeeded" });
    const episode = Bun.spawn([process.execPath, "--preload", preload, cli, "create-episode", "first"], { cwd: directory,
      env: environment, stdout: "pipe", stderr: "pipe" });
    const [episodeError, episodeCode] = await Promise.all([new Response(episode.stderr).text(), episode.exited]);
    await new Response(episode.stdout).text(); expect(episodeCode, episodeError).toBe(0);
    writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
    await command(["update-episode", "first"], directory); await command(["update-episode-audio", "first", "audio.mp3"], directory);
    const publication = await command(["publish-episode", "first"], directory); expect(publication).toMatchObject({ state: "succeeded" });
    expect(await command(["job-status", String(publication.job_id)])).toMatchObject({ status: { state: "succeeded" } });
    expect(await command(["list-shows", "--json"])).toMatchObject({ shows: [{ show_id: "daily", lifecycle: "published" }] });
    expect(await command(["list-episodes", "daily", "--json"])).toMatchObject({ episodes: [{ episode_id: "first", lifecycle: "published" }] });
    await command(["service-pause", crypto.randomUUID()]);
    expect(await command(["service-status"])).toMatchObject({ state: "paused", drained: true });
    expect(setup.calls.some((call) => /queues|event_notifications/.test(call.path))).toBe(false);
  } finally { server.stop(true); setup.close(); }
}, 30000);
