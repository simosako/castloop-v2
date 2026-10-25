import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { comparePublishedEpisodes } from "../packages/shared/src/episode-order";
import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import { SITE_PAGE_SIZE, sitePagePath, sitePageUrl } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import { assertPublicationInventoryBudget, publicationCharacterLength } from "../packages/shared/src/publication-budget";

export type SiteShow = Pick<ShowMetadata, "show_id" | "title" | "description" | "language" | "author" | "copyright">;
export type SiteRenderInput = { show: SiteShow; origin: string; coverExtension: "jpg" | "png" };
export const SITE_HTML_LIMIT_BYTES = 1_000_000;
export const SITE_CSS = "body{font:1rem/1.6 system-ui,sans-serif;max-width:48rem;margin:auto;padding:1rem;overflow-wrap:anywhere}audio{display:block;width:100%;max-width:100%}img{max-width:12rem;height:auto}article{border-top:1px solid;padding:1rem 0}.description{white-space:pre-wrap}a:focus-visible,audio:focus-visible{outline:3px solid #1769aa;outline-offset:3px}nav{display:flex;gap:2rem;flex-wrap:wrap}";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function excerpt(value: string): string {
  const characters = Array.from(value);
  return characters.length > 160 ? `${characters.slice(0, 160).join("")}…` : value;
}

export async function siteCssHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SITE_CSS));
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

function episodeArticle(input: SiteRenderInput, episode: EpisodeRevision, full: boolean): string {
  const path = sitePagePath({ kind: "episode", showId: input.show.show_id, episodeId: episode.episode_id });
  const audio = escapeHtml(audioPath(episode, input.show.show_id));
  const heading = full ? "h1" : "h2", id = `episode-${episode.episode_id}-title`;
  return `<article aria-labelledby="${id}"><${heading} id="${id}"><a href="${path}">${escapeHtml(episode.title)}</a></${heading}>` +
    `<time datetime="${escapeHtml(episode.published_at)}">${escapeHtml(episode.published_at)}</time>` +
    `<p class="description">${escapeHtml(full ? episode.description : excerpt(episode.description))}</p>` +
    `<audio controls preload="none" aria-labelledby="${id}"><source src="${audio}" type="audio/mpeg">` +
    `このブラウザは音声プレイヤーに対応していません。</audio><p><a href="${audio}">音声ファイルを開く</a></p></article>`;
}

function document(input: SiteRenderInput, page: SitePage, title: string, description: string, body: string): string {
  const canonical = sitePageUrl(input.origin, page), root = sitePagePath({ kind: "listing", showId: input.show.show_id, page: 1 });
  const cover = `${input.origin}${root}cover.${input.coverExtension}`;
  const html = `<!doctype html><html lang="${escapeHtml(input.show.language)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<meta name="description" content="${escapeHtml(excerpt(description))}"><link rel="canonical" href="${escapeHtml(canonical)}">` +
    `<link rel="alternate" type="application/rss+xml" title="RSS" href="${root}feed.xml">` +
    `<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">` +
    `<meta property="og:description" content="${escapeHtml(excerpt(description))}"><meta property="og:url" content="${escapeHtml(canonical)}">` +
    `<meta property="og:image" content="${escapeHtml(cover)}"><style>${SITE_CSS}</style></head><body>` +
    `<header><a href="${root}">${escapeHtml(input.show.title)}</a><p><a href="${root}feed.xml">RSSで購読</a></p></header>` +
    `<main>${body}</main>${input.show.copyright ? `<footer>${escapeHtml(input.show.copyright)}</footer>` : ""}</body></html>`;
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

export function renderSiteListingPage(input: SiteRenderInput, episodes: EpisodeRevision[], page: number, pages: number): string {
  const target: SitePage = { kind: "listing", showId: input.show.show_id, page };
  sitePagePath(target);
  if (!Number.isSafeInteger(pages) || pages < 1 || page > pages || episodes.length > SITE_PAGE_SIZE) throw new Error("Site listing page is missing");
  const root = sitePagePath({ kind: "listing", showId: input.show.show_id, page: 1 });
  const articles = episodes.map((episode) => episodeArticle(input, episode, false)).join("");
  const navigation = `<nav aria-label="Episode一覧">` +
    (page > 1 ? `<a href="${sitePagePath({ ...target, page: page - 1 })}">新しい回</a>` : "") +
    (page < pages ? `<a href="${sitePagePath({ ...target, page: page + 1 })}">以前の回</a>` : "") + `</nav>`;
  return document(input, target, input.show.title, input.show.description,
    `<h1>${escapeHtml(input.show.title)}</h1><img src="${root}cover.${input.coverExtension}" alt="${escapeHtml(input.show.title)}のカバー">` +
    `<p>${escapeHtml(input.show.author)}</p><p class="description">${escapeHtml(input.show.description)}</p>` +
    (articles || `<p>公開済みのEpisodeはありません。</p>`) + navigation);
}

export function renderSiteEpisode(input: SiteRenderInput, episode: EpisodeRevision): string {
  return document(input, { kind: "episode", showId: input.show.show_id, episodeId: episode.episode_id },
    `${episode.title} — ${input.show.title}`, episode.description, episodeArticle(input, episode, true));
}
