import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft } from "@castloop/shared";
import { runSqliteCommand } from "./sqlite-commands";
import { verifyResultSchema } from "./verify";
import type { VerifyResult } from "./verify";
import { initializeSqliteService } from "./sqlite-initialization";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import type { R2RestTransport } from "./bounded-http-read";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });

const ORIGIN = "https://test-worker.example.workers.dev";
const AUDIO_BYTES = 50 * 417;

type PublicRouter = { feed?: (url: URL) => Response };
function publicTransport(value: Awaited<ReturnType<typeof sqliteServiceFixture>>, router: PublicRouter): R2RestTransport {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/podcasts/")) return value.transport(input, init);
    if (url.pathname.endsWith("/feed.xml")) {
      const response = router.feed ? router.feed(url) : new Response(null, { status: 404 });
      return response;
    }
    if (url.pathname.endsWith("/cover.jpg")) {
      return new Response(null, { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": "4" } });
    }
    if (url.pathname.endsWith(".mp3")) {
      return new Response(null, { status: 200, headers: { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO_BYTES) } });
    }
    return new Response(null, { status: 404 });
  };
}

function feedXml(guids: Array<{ episode: string; guid: string; linked: boolean }>, enclosureOrigin = ORIGIN): string {
  const items = guids.map(({ episode, guid, linked }) => linked
    ? `<item><guid>${guid}</guid><enclosure url="${enclosureOrigin}/podcasts/daily/episodes/${episode}/${crypto.randomUUID()}.mp3" type="audio/mpeg"/></item>`
    : "").join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>daily</title>` +
    `<itunes:image href="${ORIGIN}/podcasts/daily/cover.jpg"/>${items}</channel></rss>`;
}

async function fixture() {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, { attempts: 2, delay: async () => {} });
  const command = (name: string, args: string[] = [], options: Parameters<typeof runSqliteCommand>[4] = {}) => runSqliteCommand(value.root, value.config, name, args,
    { transport: value.transport, cloudflare: value.options, ...options });
  return Object.assign(value, { command });
}

async function publishedShowWithEpisode(value: Awaited<ReturnType<typeof fixture>>) {
  await value.command("create-show", ["daily", "https://example.com/my-podcast"]);
 
  const directory = join(value.root, "daily");
  writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("publish-show", ["daily"]);
  await value.command("create-episode", ["daily", "first"]);
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await value.command("publish-episode", ["daily", "first", "audio.mp3"]);
  const guid = parseEpisodeDraft(readFileSync(join(directory, "episode-first.toml"), "utf8")).guid;
  return { guid };
}

function find(result: VerifyResult, id: string) {
  return result.checks.find((entry) => entry.id === id);
}

test("verify passes a served feed, cover and audio and separates processing from delivery", async () => {
  const value = await fixture();
  const { guid } = await publishedShowWithEpisode(value);
  const transport = publicTransport(value, { feed: () => new Response(feedXml([{ episode: "first", guid, linked: true }]), { headers: { "Content-Type": "application/rss+xml" } }) });
  const result = verifyResultSchema.parse(await value.command("verify", ["daily"], { transport }));
  expect(find(result, "feed-status")).toMatchObject({ scope: "external", status: "pass", code: "feed_served" });
  expect(find(result, "feed-content")).toMatchObject({ status: "pass", code: "feed_content_verified" });
  expect(find(result, "cover")).toMatchObject({ status: "pass", code: "cover_served" });
  expect(find(result, "audio")).toMatchObject({ status: "not_checked", code: "audio_not_requested" });
  expect(find(result, "unpublished-episodes")).toMatchObject({ status: "pass", code: "no_unpublished_episodes" });
  expect(result.processing).toMatchObject({ state: "succeeded" });
  expect(result.summary.fail).toBe(0);
  const scoped = verifyResultSchema.parse(await runSqliteCommand(value.root, value.config, "verify", ["daily"],
    { transport, verifyOptions: { episodeId: "first" } }));
  expect(find(scoped, "audio")).toMatchObject({ status: "pass", code: "audio_served" });
  expect(scoped.episode_id).toBe("first");
});

test("verify fails a missing published feed and classifies transport failure", async () => {
  const value = await fixture();
  await publishedShowWithEpisode(value);
  const absent = verifyResultSchema.parse(await value.command("verify", ["daily"], { transport: publicTransport(value, {}) }));
  expect(find(absent, "feed-status")).toMatchObject({ status: "fail", code: "published_feed_missing" });
  expect(absent.summary.fail).toBeGreaterThan(0);
  const failing: R2RestTransport = async () => { throw new Error("network partition"); };
  const unreachable = verifyResultSchema.parse(await value.command("verify", ["daily"], { transport: failing }));
  expect(find(unreachable, "feed-status")).toMatchObject({ status: "fail", code: "feed_transport_error" });
});

test("verify distinguishes paused 503, missing GUIDs and wrong enclosure origins", async () => {
  const value = await fixture();
  const { guid } = await publishedShowWithEpisode(value);
  const paused = verifyResultSchema.parse(await value.command("verify", ["daily"],
    { transport: publicTransport(value, { feed: () => new Response(null, { status: 503 }) }) }));
  expect(find(paused, "feed-status")).toMatchObject({ status: "warn", code: "feed_unavailable" });
  expect(find(paused, "feed-content")).toMatchObject({ status: "not_checked", code: "feed_not_fetched" });
  expect(find(paused, "cover")).toMatchObject({ status: "not_checked", code: "cover_url_unknown" });
  const wrongGuid = verifyResultSchema.parse(await value.command("verify", ["daily"],
    { transport: publicTransport(value, { feed: () => new Response(feedXml([{ episode: "first", guid: "other-guid", linked: true }]), { headers: { "Content-Type": "application/rss+xml" } }) }) }));
  expect(find(wrongGuid, "feed-content")).toMatchObject({ status: "fail", code: "guid_missing" });
  const wrongOrigin = verifyResultSchema.parse(await value.command("verify", ["daily"],
    { transport: publicTransport(value, { feed: () => new Response(feedXml([{ episode: "first", guid, linked: true }], "https://elsewhere.example.com"), { headers: { "Content-Type": "application/rss+xml" } }) }) }));
  expect(find(wrongOrigin, "feed-content")).toMatchObject({ status: "fail", code: "enclosure_origin_mismatch" });
});

test("verify warns when an unpublished episode appears in the feed", async () => {
  const value = await fixture();
  const { guid } = await publishedShowWithEpisode(value);
  await value.command("create-episode", ["daily", "second"]);
  const secondGuid = parseEpisodeDraft(readFileSync(join(value.root, "daily", "episode-second.toml"), "utf8")).guid;
  const result = verifyResultSchema.parse(await value.command("verify", ["daily"],
    { transport: publicTransport(value, { feed: () => new Response(feedXml(
      [{ episode: "first", guid, linked: true }, { episode: "second", guid: secondGuid, linked: true }]), { headers: { "Content-Type": "application/rss+xml" } }) }) }));
  expect(find(result, "unpublished-episodes")).toMatchObject({ status: "warn", code: "linked_without_publication_evidence" });
  const clean = verifyResultSchema.parse(await value.command("verify", ["daily"],
    { transport: publicTransport(value, { feed: () => new Response(feedXml(
      [{ episode: "first", guid, linked: true }, { episode: "second", guid: secondGuid, linked: false }]), { headers: { "Content-Type": "application/rss+xml" } }) }) }));
  expect(find(clean, "unpublished-episodes")).toMatchObject({ status: "pass", code: "unpublished_not_linked" });
  const audioMissing = verifyResultSchema.parse(await runSqliteCommand(value.root, value.config, "verify", ["daily"],
    { transport: publicTransport(value, { feed: () => new Response(feedXml([{ episode: "first", guid, linked: true }]), { headers: { "Content-Type": "application/rss+xml" } }) }),
      verifyOptions: { episodeId: "second" } }));
  expect(find(audioMissing, "audio")).toMatchObject({ status: "not_checked", code: "audio_no_local_expectation" });
});
