import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { comparePublishedEpisodes } from "../packages/shared/src/episode-order";
import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import { SITE_PAGE_SIZE, sitePagePath, sitePageUrl } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import { assertPublicationInventoryBudget, publicationCharacterLength } from "../packages/shared/src/publication-budget";
import { validateSiteCss } from "../packages/shared/src/site-style";
import { escapeSiteText as escapeHtml, formatSiteDescription } from "./site-description";
import type { SiteDescription } from "./site-description";

export type SiteShow = Pick<ShowMetadata, "show_id" | "title" | "description" | "language" | "author" | "copyright" | "site_css" | "site_timezone">;
export type SiteRenderInput = { show: SiteShow; origin: string; coverExtension: "jpg" | "png"; episodeSiteIds: Record<string, string> };
export const SITE_HTML_LIMIT_BYTES = 1_000_000;
export const SITE_CSS = `:root{color-scheme:light;--cl-accent:#245c65;--cl-background:#f5f7f8;--cl-text:#202b33;--cl-muted:#53636e;--cl-content-width:64rem;--cl-radius:1rem}
.cl-description.cl-description-full{white-space:normal}.cl-description-full p{margin:0 0 1em}.cl-description-full p:last-child{margin-bottom:0}.cl-description-link{color:inherit;text-decoration:none}.cl-read-more{color:var(--cl-accent);text-decoration:underline}.cl-description-link:hover .cl-read-more{text-decoration-thickness:2px}
*{box-sizing:border-box}body{margin:0;background:var(--cl-background);color:var(--cl-text);font:1rem/1.7 system-ui,sans-serif;overflow-wrap:anywhere}a{color:var(--cl-accent);text-underline-offset:.2em}a:hover{text-decoration-thickness:2px}a:focus-visible,audio:focus-visible{outline:3px solid var(--cl-accent);outline-offset:4px}h1,h2{line-height:1.35}h1{font-size:clamp(1.8rem,4vw,2.7rem)}h2{font-size:1.3rem;margin:0 0 .6rem}.cl-header,.cl-main,.cl-footer{max-width:var(--cl-content-width);margin:auto;padding:1.5rem}.cl-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;border-bottom:1px solid #d4dee2}.cl-brand{font-weight:700;text-decoration:none}.cl-subscribe{font-weight:600}.cl-show{display:grid;grid-template-columns:minmax(0,12rem) minmax(0,1fr);gap:2rem;align-items:center;margin:1rem 0 3rem}.cl-show h1{margin:0 0 .6rem}.cl-cover{display:block;width:100%;max-width:12rem;height:auto;border-radius:var(--cl-radius)}.cl-author,.cl-episode-date,.cl-footer{color:var(--cl-muted)}.cl-description{white-space:pre-wrap}.cl-episode-list{display:grid;gap:1.5rem}.cl-episode{min-width:0;background:#fff;border:1px solid #d4dee2;border-radius:var(--cl-radius);padding:clamp(1rem,3vw,2rem)}.cl-episode-title a{text-decoration:none}.cl-episode-title a:hover{text-decoration:underline}.cl-player{display:block;width:100%;margin:1.5rem 0 1rem}.cl-audio-link{font-size:.9rem}.cl-pagination{display:flex;justify-content:space-between;gap:2rem;flex-wrap:wrap;margin:2rem 0}.cl-footer{font-size:.9rem}@media(max-width:36rem){.cl-show{grid-template-columns:1fr;gap:1rem}.cl-cover{max-width:10rem}.cl-header,.cl-main,.cl-footer{padding:1rem}}`;

export function siteStyles(customCss = ""): string {
  return customCss ? `${SITE_CSS}\n${validateSiteCss(customCss)}` : SITE_CSS;
}

export async function siteCssHash(customCss = ""): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(siteStyles(customCss)));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export function siteContentSecurityPolicy(cssHash: string): string {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(cssHash)) throw new Error("Invalid site CSS hash");
  return `default-src 'none'; script-src 'none'; style-src 'sha256-${cssHash}'; img-src 'self'; media-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`;
}

function audioPath(episode: EpisodeRevision, showId: string): string {
  const url = new URL(episode.enclosure_url), asset = parsePublicAssetPath(url.pathname);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    !asset || asset.kind !== "audio" || asset.showId !== showId || asset.episodeId !== episode.episode_id) {
    throw new Error("Site Episode has an invalid approved audio reference");
  }
  return url.pathname;
}

export function siteDateFormatter(timeZone = "UTC"): (timestamp: string) => string {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset" });
  return (timestamp) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    const offset = parts.timeZoneName === "GMT" ? "UTC+00:00" : parts.timeZoneName.replace(/^GMT/, "UTC");
    return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day} (${offset})`;
  };
}

function episodeArticle(input: SiteRenderInput, episode: EpisodeRevision, description: SiteDescription, full: boolean,
  formatDate: (timestamp: string) => string): string {
  const path = sitePagePath({ kind: "episode", showId: input.show.show_id, siteId: input.episodeSiteIds[episode.episode_id] });
  const audio = escapeHtml(audioPath(episode, input.show.show_id));
  const heading = full ? "h1" : "h2", id = `episode-${episode.episode_id}-title`;
  return `<article class="cl-episode" aria-labelledby="${id}"><${heading} class="cl-episode-title" id="${id}"><a href="${path}">${escapeHtml(episode.title)}</a></${heading}>` +
    `<time class="cl-episode-date" datetime="${escapeHtml(episode.published_at)}">${formatDate(episode.published_at)}</time>` +
    (full ? `<div class="cl-description cl-description-full">${description.html}</div>` : description.excerpt ?
      `<p class="cl-description"><a class="cl-description-link" href="${path}">${escapeHtml(description.excerpt)} <span class="cl-read-more">全文を読む</span></a></p>` : "") +
    `<audio controls preload="none" class="cl-player" aria-labelledby="${id}"><source src="${audio}" type="audio/mpeg">` +
    `このブラウザは音声プレイヤーに対応していません。</audio><p class="cl-audio-link"><a href="${audio}">音声ファイルを開く</a></p></article>`;
}

function document(input: SiteRenderInput, page: SitePage, title: string, description: string, body: string): string {
  const canonical = sitePageUrl(input.origin, page), root = sitePagePath({ kind: "listing", showId: input.show.show_id, page: 1 });
  const cover = `${input.origin}${root}cover.${input.coverExtension}`;
  const html = `<!doctype html><html lang="${escapeHtml(input.show.language)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}">` +
    `<link rel="alternate" type="application/rss+xml" title="RSS" href="${root}feed.xml">` +
    `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">` +
    `<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}">` +
    `<meta property="og:image" content="${escapeHtml(cover)}"><style>${siteStyles(input.show.site_css)}</style></head><body class="cl-site cl-page-${page.kind === "listing" ? "list" : "episode"}">` +
    `<header class="cl-header"><a class="cl-brand" href="${root}">${escapeHtml(input.show.title)}</a><a class="cl-subscribe" href="${root}feed.xml">RSSで購読</a></header>` +
    `<main class="cl-main">${body}</main></body></html>`;
  if (new TextEncoder().encode(html).byteLength > SITE_HTML_LIMIT_BYTES) throw new Error("Site HTML exceeds its rendering budget");
  return html;
}

export function orderedSiteEpisodes(episodes: EpisodeRevision[]): EpisodeRevision[] {
  assertPublicationInventoryBudget(episodes.length, episodes.reduce((sum, episode) => sum + publicationCharacterLength(JSON.stringify(episode)), 0));
  return episodes.toSorted(comparePublishedEpisodes);
}

export function renderSiteListing(input: SiteRenderInput, episodes: EpisodeRevision[], page: number): string {
  const ordered = orderedSiteEpisodes(episodes), pages = Math.max(1, Math.ceil(ordered.length / SITE_PAGE_SIZE));
  return renderSiteListingPage(input, ordered.slice((page - 1) * SITE_PAGE_SIZE, page * SITE_PAGE_SIZE), page, pages);
}

export function renderSiteListingPage(input: SiteRenderInput, episodes: EpisodeRevision[], page: number, pages: number,
  formatDate = siteDateFormatter(input.show.site_timezone)): string {
  const target: SitePage = { kind: "listing", showId: input.show.show_id, page };
  sitePagePath(target);
  if (!Number.isSafeInteger(pages) || pages < 1 || page > pages || episodes.length > SITE_PAGE_SIZE) throw new Error("Site listing page is missing");
  const root = sitePagePath({ kind: "listing", showId: input.show.show_id, page: 1 });
  const description = formatSiteDescription(input.show.description);
  const articles = episodes.map((episode) => episodeArticle(input, episode, formatSiteDescription(episode.description), false, formatDate)).join("");
  const navigation = `<nav class="cl-pagination" aria-label="Episode一覧">` +
    (page > 1 ? `<a href="${sitePagePath({ ...target, page: page - 1 })}">新しい回</a>` : "") +
    (page < pages ? `<a href="${sitePagePath({ ...target, page: page + 1 })}">以前の回</a>` : "") + `</nav>`;
  return document(input, target, input.show.title, description.excerpt,
    `<section class="cl-show" aria-labelledby="show-title"><img class="cl-cover" src="${root}cover.${input.coverExtension}" alt="${escapeHtml(input.show.title)}のカバー">` +
    `<div><h1 id="show-title">${escapeHtml(input.show.title)}</h1><p class="cl-author">${escapeHtml(input.show.author)}</p><div class="cl-description cl-description-full">${description.html}</div></div></section>` +
    `<div class="cl-episode-list">${articles || `<p>公開済みのEpisodeはありません。</p>`}</div>` + navigation);
}

export function renderSiteEpisode(input: SiteRenderInput, episode: EpisodeRevision,
  formatDate = siteDateFormatter(input.show.site_timezone)): string {
  const description = formatSiteDescription(episode.description);
  return document(input, { kind: "episode", showId: input.show.show_id, siteId: input.episodeSiteIds[episode.episode_id] },
    `${episode.title} — ${input.show.title}`, description.excerpt, episodeArticle(input, episode, description, true, formatDate));
}
