import { expect, test } from "bun:test";
import type { EpisodeRevision } from "../packages/shared/src/index";
import { showMetadataSchema } from "../packages/shared/src/index";
import { parseSitePagePath, sitePagePath, siteSnapshotKey } from "../packages/shared/src/website";
import { SITE_CSS, renderSiteEpisode, renderSiteListing, renderSiteListingPage, siteContentSecurityPolicy, siteCssHash } from "./site-renderer";
import { serveSiteGateway } from "./site-gateway";
import { serveCachedSitePage } from "./site-cache";
import { persistSitePage, purgeSitePages, sitePurgeTags } from "./site-storage";
import type { SiteCacheProps } from "./site-cache";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";
import { createHash } from "node:crypto";

const origin = "https://podcast.example.com";
const shortId = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
const input = { origin, coverExtension: "jpg" as const, show: { show_id: "daily", title: "番組", description: "紹介",
  language: "ja", author: "著者", owner_email: "private@example.com", image_path: "local-cover.jpg" },
  episodeSiteIds: Object.fromEntries(["first", "offset", "old", "z", "a-b", "a",
    ...Array.from({ length: 21 }, (_, index) => `ep-${String(index).padStart(2, "0")}`)].map((id) => [id, shortId(id)])) };
const audioId = "00000000-0000-4000-8000-000000000001";
function episode(id = "first", date = "2026-10-25T00:00:00Z"): EpisodeRevision {
  return { schema_version: 1, episode_id: id, title: id, description: "説明", guid: `guid-${id}`, published_at: date,
    revision_id: audioId, enclosure_url: `${origin}/podcasts/daily/episodes/${id}/${audioId}.mp3`,
    content_type: "audio/mpeg", length_bytes: 100, duration_seconds: 10, sha256: "a".repeat(64), updated_at: date };
}

test("site choices are strict and external URLs cannot carry executable schemes or credentials", () => {
  const metadata = { ...input.show, schema_version: 1, owner_name: "Owner", owner_email: "private@example.com",
    categories: ["Technology"], explicit: false };
  const parse = (value: object) => showMetadataSchema.parse({ ...metadata, ...value });
  expect(parse({ site_mode: "builtin" }).site_url).toBeUndefined();
  expect(parse({ site_mode: "external", site_url: "https://example.com/" }).site_mode).toBe("external");
  expect(parse({ site_url: "https://example.com/" }).site_mode).toBeUndefined();
  for (const value of [{ site_mode: "builtin", site_url: "https://example.com" }, { site_mode: "external" },
    { site_mode: "external", site_url: "javascript:alert(1)" }, { site_mode: "external", site_url: "https://u:p@example.com" },
    { site_mode: "external", site_url: "https://example.com/#fragment" }, {}, { site_mode: "unknown" },
    { site_mode: "builtin", unknown: true }]) expect(() => parse(value)).toThrow();
});

test("site paths allow only canonical Show pages, numbered listings and stable Episode pages", () => {
  for (const page of [{ kind: "listing" as const, showId: "daily", page: 1 }, { kind: "listing" as const, showId: "daily", page: 2 },
    ...[16, 20, 64].map((length) => ({ kind: "episode" as const, showId: "daily", siteId: "a".repeat(length) }))]) {
    expect(parseSitePagePath(sitePagePath(page))).toEqual(page);
    expect(siteSnapshotKey(page, 3)).toStartWith("public/podcasts/daily/sites/3/");
  }
  for (const path of ["/", "/admin/", "/system/x", "/staging/x", "/podcasts/daily", "/podcasts/daily/page/1/",
    "/podcasts/daily/page/0/", "/podcasts/daily/page/02/", "/podcasts/daily/page/9007199254740992/",
    "/podcasts/daily/sites/1/index.html", "/podcasts/daily/episodes/first/metadata.toml", "/podcasts/daily/episodes/%66irst/",
    "/podcasts/daily/episodes/first/", "/podcasts/daily/e/0123456789abcdef/", "/podcasts/daily/first/",
    ...[15, 17, 19, 65].map((length) => `/podcasts/daily/${"a".repeat(length)}/`),
    "/podcasts/daily/0123456789abcdeF/", "/podcasts/daily/%610123456789abcde/"])
    expect(parseSitePagePath(path)).toBeNull();
  expect(() => siteSnapshotKey({ kind: "listing", showId: "../private", page: 1 }, 1)).toThrow();
  expect(() => siteSnapshotKey({ kind: "listing", showId: "daily", page: 1 }, 0)).toThrow();
});

test("listings render zero, one, twenty and twenty-one Episodes with in-place native players", () => {
  for (const count of [0, 1, 20, 21]) {
    const episodes = Array.from({ length: count }, (_, index) => episode(`ep-${String(index).padStart(2, "0")}`));
    const html = renderSiteListing(input, episodes, 1);
    expect((html.match(/<audio controls preload="none"/g) ?? []).length).toBe(Math.min(count, 20));
    expect(html.includes('href="/podcasts/daily/page/2/"')).toBe(count > 20);
    expect(html).not.toContain("private@example.com");
    expect(html).not.toContain("local-cover.jpg");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("autoplay");
    if (count === 21) {
      const next = renderSiteListing(input, episodes, 2);
      expect((next.match(/<audio /g) ?? []).length).toBe(1);
      expect(next).toContain('rel="canonical" href="https://podcast.example.com/podcasts/daily/page/2/"');
    }
  }
  expect(() => renderSiteListing(input, [], 2)).toThrow();
  expect(() => renderSiteListingPage(input, Array.from({ length: 21 }, () => episode()), 1, 2)).toThrow();
});

test("listing order matches Feed dates and ID ties without modifying its input", () => {
  const episodes = [episode("old", "2026-10-24T00:00:00Z"), episode("z"), episode("a-b"), episode("a")];
  const html = renderSiteListing(input, episodes, 1);
  const expected = episodes.toSorted((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || a.episode_id.localeCompare(b.episode_id));
  const positions = expected.map((item) => html.indexOf(`id="episode-${item.episode_id}-title"`));
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  expect(episodes[0].episode_id).toBe("old");
});

test("HTML and attributes escape imported text; rich HTML and inline handlers never execute", () => {
  const hostile = `<img src=x onerror="alert(1)"></style><script>bad()</script>&'`;
  const html = renderSiteEpisode({ ...input, show: { ...input.show, title: hostile, description: hostile } },
    { ...episode(), title: hostile, description: hostile });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&quot;alert(1)&quot;");
  expect(html).toContain("&amp;&#39;");
  expect(() => renderSiteEpisode({ ...input, origin: "https://public.example.com/evil" }, episode())).toThrow();
  expect(() => renderSiteEpisode(input, { ...episode(), enclosure_url: "javascript:alert(1)" })).toThrow();
  expect(() => renderSiteEpisode(input, { ...episode(), enclosure_url: `${origin}/staging/audio.mp3` })).toThrow();
  expect(() => renderSiteEpisode(input, { ...episode(), enclosure_url: `${episode().enclosure_url}?secret=x` })).toThrow();
});

test("description links lead to existing full pages, without enclosing the native player", () => {
  const description = `<p>${"日😀".repeat(81)}</p><p>次の段落<br>全文の最後</p>`;
  const revision = { ...episode(), description };
  const before = JSON.stringify(revision);
  const html = renderSiteListing(input, [revision], 1);
  expect(html).toContain(`<a class="cl-description-link" href="/podcasts/daily/${shortId("first")}/">${"日😀".repeat(80)}… <span class="cl-read-more">全文を読む</span></a>`);
  expect(html).not.toContain("全文の最後");
  expect(html).toContain('</a></p><audio controls preload="none"');
  const full = renderSiteEpisode(input, revision);
  expect(full).toContain(`<div class="cl-description cl-description-full">${description}</div>`);
  expect(full).toContain(`<meta name="description" content="${"日😀".repeat(80)}…">`);
  expect(JSON.stringify(revision)).toBe(before);
  expect(renderSiteListing(input, [{ ...revision, description: "<img src=x>" }], 1)).not.toContain('class="cl-description-link"');
  const show = renderSiteListing({ ...input, show: { ...input.show, description: "<p>番組<br>紹介 &amp; 補足</p>" } }, [], 1);
  expect(show).toContain('<div class="cl-description cl-description-full"><p>番組<br>紹介 &amp; 補足</p></div>');
  expect(show).toContain('<meta name="description" content="番組 紹介 &amp; 補足">');
});

test("Episode URLs stay fixed on metadata and audio revisions while approved MP3 references change", () => {
  const before = renderSiteEpisode(input, episode());
  const nextId = "00000000-0000-4000-8000-000000000002";
  const after = renderSiteEpisode(input, { ...episode(), title: "改訂", revision_id: nextId,
    enclosure_url: episode().enclosure_url.replace(audioId, nextId) });
  for (const html of [before, after]) expect(html).toContain(`rel="canonical" href="${origin}/podcasts/daily/${shortId("first")}/"`);
  expect(before).toContain(`${audioId}.mp3`);
  expect(after).toContain(`${nextId}.mp3`);
});

test("site pages omit the copyright footer, retain the Show author, and link full descriptions only", () => {
  const description = '<p>資料 https://example.com/info <a href="http://example.org/docs">詳しく読む</a></p>';
  const show = { ...input.show, copyright: "Copyright Owner", description };
  const revision = { ...episode(), description }, before = JSON.stringify({ show, revision });
  const listing = renderSiteListing({ ...input, show }, [revision], 1);
  const full = renderSiteEpisode({ ...input, show }, revision);
  for (const html of [listing, full]) {
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("Copyright Owner");
    expect(html).toContain('<a href="https://example.com/info">https://example.com/info</a>');
    expect(html).toContain('<a href="http://example.org/docs">詳しく読む</a>');
    expect(html).toContain('<meta name="description" content="資料 https://example.com/info 詳しく読む">');
  }
  expect(listing).toContain('<p class="cl-author">著者</p>');
  expect(listing).toContain(`<a class="cl-description-link" href="/podcasts/daily/${shortId("first")}/">資料 https://example.com/info 詳しく読む <span`);
  expect(JSON.stringify({ show, revision })).toBe(before);
});

test("CSP hashes exactly the fixed stylesheet and rejects header injection", async () => {
  const hash = await siteCssHash();
  expect(hash).toBe(createHash("sha256").update(SITE_CSS).digest("base64"));
  expect(siteContentSecurityPolicy(hash)).toContain(`style-src 'sha256-${hash}'`);
  expect(siteContentSecurityPolicy(hash)).toContain("script-src 'none'");
  expect(() => siteContentSecurityPolicy("' unsafe-inline")).toThrow();
});

test("custom CSS follows the default style and has an exact per-page CSP hash", async () => {
  const css = ":root{--cl-accent:#882244}\n.cl-episode{border-radius:0}";
  const html = renderSiteListing({ ...input, show: { ...input.show, site_css: css } }, [episode()], 1);
  expect(html).toContain(`<style>${SITE_CSS}\n${css}</style>`);
  const hash = await siteCssHash(css);
  expect(hash).toBe(createHash("sha256").update(`${SITE_CSS}\n${css}`).digest("base64"));
  expect(hash).not.toBe(await siteCssHash());
  expect(html).toContain('class="cl-site cl-page-list"');
  expect(html).toContain('class="cl-player"');
  expect(renderSiteEpisode(input, episode("offset", "2026-10-26T01:00:00+09:00"))).toContain("2026-10-25 (UTC)");
  for (const css of ["a".repeat(65_537), "\u0000", "\r", "\ud800", "/* </STYLE> */"]) {
    expect(() => renderSiteListing({ ...input, show: { ...input.show, site_css: css } }, [], 1)).toThrow();
  }
  const boundary = "/*" + "あ".repeat(21_844) + "*/";
  expect(Buffer.byteLength(boundary)).toBe(65_536);
  expect(renderSiteListing({ ...input, show: { ...input.show, site_css: boundary } }, [], 1)).toContain(boundary);
});

async function cachedFixture() {
  const objects = sqlitePublicationBucket(), page = { kind: "listing" as const, showId: "daily", page: 1 };
  const html = renderSiteListing(input, [], 1), sha256 = createHash("sha256").update(html).digest("hex");
  const props: SiteCacheProps = { generation: 1, showGeneration: 1, cssHash: await siteCssHash(), sha256,
    lengthBytes: Buffer.byteLength(html) };
  await objects.bucket.put(siteSnapshotKey(page, 1), html, { sha256 });
  return { ...objects, props, html, page };
}

test("site cache verifies immutable object identity and retains security headers on HEAD and 304", async () => {
  const f = await cachedFixture(), url = `${origin}/podcasts/daily/`;
  const bucket = f.bucket as unknown as Pick<R2Bucket, "head" | "get">;
  const response = await serveCachedSitePage(new Request(url), bucket, f.props);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(f.html);
  for (const request of [new Request(url, { method: "HEAD" }), new Request(url, { headers: { "If-None-Match": response.headers.get("ETag")! } })]) {
    const result = await serveCachedSitePage(request, bucket, f.props);
    expect(result.status).toBe(request.method === "HEAD" ? 200 : 304);
    expect(await result.text()).toBe("");
    expect(result.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
  }
  expect((await serveCachedSitePage(new Request(url), bucket, { ...f.props, sha256: "b".repeat(64) })).status).toBe(503);
  expect((await serveCachedSitePage(new Request(url), bucket, { ...f.props, generation: 2 })).status).toBe(503);
});

test("latest gate always precedes cache, redirect and conditional responses; credentials never reach cache", async () => {
  const f = await cachedFixture();
  let state: 200 | 404 | 410 | 503 = 200, calls = 0;
  const gateway = { managementOrigin: "https://old.example.workers.dev", publicOrigin: origin,
    delivery: async () => state === 200 ? { status: 200 as const, props: f.props } : { status: state },
    cachedFetch: async (request: Request) => {
      calls++;
      expect(request.headers.get("Authorization")).toBeNull();
      expect(request.headers.get("Cookie")).toBeNull();
      expect(new URL(request.url).search).toBe("");
      return new Response(f.html, { headers: { "Cache-Tag": "private", "Cache-Control": "public, max-age=300" } });
    } };
  const response = await serveSiteGateway(new Request(`${origin}/podcasts/daily/?secret=x`, { headers: { Authorization: "secret", Cookie: "a=b" } }), gateway);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Tag")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
  expect(calls).toBe(1);
  for (const status of [404, 410, 503] as const) {
    state = status;
    for (const base of [origin, gateway.managementOrigin]) {
      const stopped = await serveSiteGateway(new Request(`${base}/podcasts/daily/`, { headers: { "If-None-Match": "*" } }), gateway);
      expect(stopped.status).toBe(status);
      expect(stopped.headers.get("Location")).toBeNull();
      expect(stopped.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  expect(calls).toBe(1);
  state = 200;
  const redirect = await serveSiteGateway(new Request(`${gateway.managementOrigin}/podcasts/daily/`), gateway);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("Location")).toBe(`${origin}/podcasts/daily/`);
  expect(calls).toBe(1);
  expect((await serveSiteGateway(new Request("https://unknown.example/podcasts/daily/"), gateway)).status).toBe(404);
});

test("site snapshots use checksum-verified conditional creation and never overwrite previous HTML", async () => {
  const f = await cachedFixture();
  const candidate = await persistSitePage(f.bucket, f.page, 2, f.html, { cssHash: f.props.cssHash, showGeneration: 1 });
  expect(candidate.props.sha256).toBe(f.props.sha256);
  expect(f.text(siteSnapshotKey(f.page, 2))).toBe(f.html);
  await expect(persistSitePage(f.bucket, f.page, 2, "replacement", { cssHash: f.props.cssHash, showGeneration: 1 })).rejects.toThrow();
  expect(f.text(siteSnapshotKey(f.page, 2))).toBe(f.html);
  expect(f.text(siteSnapshotKey(f.page, 1))).toBe(f.html);
});

test("oversized HTML is rejected before PUT and uncertain writes are never replayed", async () => {
  const f = await cachedFixture();
  f.calls.length = 0;
  await expect(persistSitePage(f.bucket, f.page, 2, "a".repeat(1_000_001), { cssHash: f.props.cssHash, showGeneration: 1 })).rejects.toThrow();
  expect(f.calls.length).toBe(0);
  f.hooks.afterPut = async () => { throw new Error("acknowledgement lost"); };
  await expect(persistSitePage(f.bucket, f.page, 2, f.html, { cssHash: f.props.cssHash, showGeneration: 1 })).rejects.toThrow();
  expect(f.calls.filter((call) => call.method === "PUT").length).toBe(1);
  expect(f.entries.has(siteSnapshotKey(f.page, 2))).toBe(true);
});

test("site purge targets do not include Feed tags and unconfirmed purge cannot succeed", async () => {
  expect(sitePurgeTags({ showId: "daily" })).toEqual(["site-daily"]);
  expect(sitePurgeTags({ showId: "daily", siteId: shortId("first") })).toEqual(["site-list-daily", `site-episode-daily/${shortId("first")}`]);
  let count = 0;
  await expect(purgeSitePages({ purge: async () => { count++; return { success: false, errors: [] }; } }, { showId: "daily" })).rejects.toThrow();
  expect(count).toBe(1);
  await purgeSitePages({ purge: async (target) => {
    expect(target).toEqual({ tags: ["site-list-daily", `site-episode-daily/${shortId("first")}`] });
    return { success: true, errors: [] };
  } }, { showId: "daily", siteId: shortId("first") });
});
