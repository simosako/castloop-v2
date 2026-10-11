import { expect, spyOn, test } from "bun:test";
import { parseEpisodeRevision, publicationCommitKey, stringifyToml } from "@castloop/shared";
import { runM6Command } from "./m6-commands";
import { readLocalLifecycleJob } from "./lifecycle-journal";
import type { M6LifecyclePlan } from "./m6-local-lifecycle";
import { readLocalPublicationJob } from "./publication-journal";
import { importRssLocally } from "./rss-import-local";
import { publishRssImport } from "./rss-import-publication";
import type { RssPublicationEffects } from "./rss-import-publication";
import { RSS_IMPORT_AUDIO, RSS_IMPORT_SOURCE, rssImportTransport } from "./test-support/rss-import";
import { fetchM6ManagementIntegration, queueM6Candidate } from "../../../src/m6-routes";
import type { M6CachedLoopback } from "../../../src/m6-routes";
import { completeM6ServiceInitialization, prepareM6ServiceInitialization } from "../../../src/m6-service-initialization";
import { resumeServiceAdmission } from "../../../src/service-admission";
import { m6InitializationFixture } from "../../../src/test-support/m6-initialization";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("RSS import uses formal runners, resumes an acknowledged job without new mutations and verifies all published identities", async () => {
  const setup = await m6InitializationFixture();
  await prepareM6ServiceInitialization(setup.env, setup.target);
  await completeM6ServiceInitialization(setup.env, setup.target, setup.checks);
  await resumeServiceAdmission(setup.env, setup.config.service_id, setup.target.operation_id);
  const parent = mkdtempSync("/tmp/opencode/castloop-rss-publication-");
  const root = join(parent, "workspace"), output = join(parent, "import");
  mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, ".castloop"), { mode: 0o700 });
  writeFileSync(join(root, ".castloop", "secrets.json"), JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" }));
  writeFileSync(join(root, "castloop.toml"), stringifyToml(setup.config));
  const item = RSS_IMPORT_SOURCE.match(/<item>[\s\S]*?<\/item>/)![0];
  const source = RSS_IMPORT_SOURCE.replace("</channel>", item.replace("old:123", "https://old.example/second")
    .replace('isPermaLink="false"', 'isPermaLink="true"').replace("01 Apr 2020", "02 Apr 2020") + "</channel>");
  await importRssLocally("imported", "https://source.example/feed", output, rssImportTransport(false, source).effects);
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID, originalToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = setup.config.account_id;
  process.env.CLOUDFLARE_API_TOKEN = "simulated-rest-token";
  const cachedAssets: M6CachedLoopback = Object.assign(() => ({ fetch: async () => new Response("asset") }),
    { ...setup.bindings.cachedAssets, invalidate: async () => {} });
  const env = { ...setup.env, CASTLOOP_DLQ_NAME: setup.config.dlq_name, CASTLOOP_QUEUE: { send: async () => { throw new Error("Unexpected continuation"); } } };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") {
      const key = url.pathname.slice(url.pathname.indexOf("/objects/") + 9);
      if (init?.method === "PUT") {
        const object = (await setup.bucket.put(key, new Uint8Array(await new Response(init.body).arrayBuffer())))!;
        return Response.json({ success: true, result: { key, size: object.size, etag: object.etag, version: object.version } });
      }
      const object = await setup.bucket.get(key);
      return object ? new Response(new Uint8Array(object.bytes), { headers: { ETag: `"${object.etag}"` } }) : new Response(null, { status: 404 });
    }
    return fetchM6ManagementIntegration(new Request(input, init) as never, env as never, cachedAssets);
  }, { preconnect: globalThis.fetch.preconnect }));
  const commands: string[] = [];
  let loseStatus = true;
  const effects: RssPublicationEffects = {
    async command(command, args) {
      commands.push(command);
      if (command === "operation-status" && loseStatus) { loseStatus = false; throw new Error("Read-only status unavailable"); }
      const result = await runM6Command(root, setup.config, command, args, { workerSource: async () => "unused" });
      if (command.startsWith("publish-")) {
        const job = readLocalPublicationJob(root, setup.config, (result as { job_id: string }).job_id).client_state!;
        await queueM6Candidate({ queue: setup.config.queue_name, messages: [{ id: crypto.randomUUID(),
          body: { object: { key: publicationCommitKey(job.publication.commit) } } }] } as never,
          env as never, cachedAssets);
      }
      return result;
    }, async readFeed() { return setup.text("public/podcasts/imported/feed.xml"); }, async wait() {}, report() {},
  };
  try {
    await expect(publishRssImport(root, setup.config, output, { ...effects, async command(command, args) {
      const result = await effects.command(command, args);
      if (command === "service-status") { const { external_episode_guids: _feature, ...old } = result as Record<string, unknown>; return old; }
      return result;
    } })).rejects.toThrow("M7-compatible");
    expect(commands).toEqual(["service-status"]);
    commands.length = 0;
    await expect(publishRssImport(root, setup.config, output, effects)).rejects.toThrow("status unavailable");
    expect(commands.filter((command) => command === "create-show")).toHaveLength(1);
    expect(commands.filter((command) => command === "create-episode")).toHaveLength(0);
    const completed = await publishRssImport(root, setup.config, output, effects);
    expect(completed).toMatchObject({ result: "rss-import-published", episode_count: 2, subscriber_migration_completed: false });
    expect(commands.filter((command) => command === "create-show")).toHaveLength(1);
    expect(commands.filter((command) => command === "publish-show")).toHaveLength(1);
    expect(commands.filter((command) => command === "publish-episode")).toHaveLength(2);
    const report = JSON.parse(readFileSync(join(output, "import.json"), "utf8"));
    for (const episode of report.episodes) {
      const revision = parseEpisodeRevision(setup.text(`public/episodes/imported/${episode.metadata.episode_id}/metadata.toml`));
      expect(revision.guid).toBe(episode.metadata.guid);
      expect(revision.guid_is_permalink).toBe(episode.metadata.guid_is_permalink);
      expect(revision.published_at).toBe(episode.metadata.published_at);
      const media = await setup.bucket.get(`public${new URL(revision.enclosure_url).pathname}`);
      expect(Buffer.from(media!.bytes)).toEqual(RSS_IMPORT_AUDIO);
    }
    const count = commands.length;
    await publishRssImport(root, setup.config, output, effects);
    expect(commands.slice(count)).toEqual(["service-status"]);
    const restoredEpisode = report.episodes.find((episode: { metadata: { guid_is_permalink: boolean } }) => episode.metadata.guid_is_permalink);
    const metadataKey = `public/episodes/imported/${restoredEpisode.metadata.episode_id}/metadata.toml`;
    const beforeLifecycle = setup.text(metadataKey);
    for (const action of ["unpublish", "restore"]) {
      const plan = await effects.command("preview-episode-lifecycle", ["imported", restoredEpisode.metadata.episode_id, action]) as M6LifecyclePlan;
      const file = join(root, `${action}.json`);
      writeFileSync(file, JSON.stringify(plan));
      const result = await effects.command("lifecycle-execute", [file, plan.preview.request_sha256, "confirm"]) as { job_id: string };
      const job = readLocalLifecycleJob(root, setup.config, result.job_id).client_state!;
      await queueM6Candidate({ queue: setup.config.queue_name, messages: [{ id: crypto.randomUUID(),
        body: { object: { key: job.commit_receipt!.key } } }] } as never, env as never, cachedAssets);
      const feed = setup.text("public/podcasts/imported/feed.xml");
      expect(feed.includes(restoredEpisode.metadata.guid)).toBe(action === "restore");
      expect(setup.text(metadataKey)).toBe(beforeLifecycle);
    }
    const unknownOutput = join(parent, "unknown-import");
    await importRssLocally("unknown", "https://source.example/feed", unknownOutput, rssImportTransport().effects);
    let unknownAttempts = 0;
    const unknownEffects = { ...effects, async command(command: string, args: string[]) {
      if (command === "create-show") { unknownAttempts++; throw new Error("Unknown registration response"); }
      return effects.command(command, args);
    } };
    await expect(publishRssImport(root, setup.config, unknownOutput, unknownEffects)).rejects.toThrow("Unknown registration");
    await expect(publishRssImport(root, setup.config, unknownOutput, unknownEffects)).rejects.toThrow("without replaying");
    expect(unknownAttempts).toBe(1);
  } finally {
    fetchSpy.mockRestore();
    if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    rmSync(parent, { recursive: true, force: true });
  }
});
