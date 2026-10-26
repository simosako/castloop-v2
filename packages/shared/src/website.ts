import { validateId } from "./ids";

export const SITE_PAGE_SIZE = 20;
export const SITE_ID_PATTERN = /^[a-f0-9]{16}(?:[a-f0-9]{4}){0,12}$/;

export type SitePage = { showId: string } & (
  { kind: "listing"; page: number } | { kind: "episode"; siteId: string }
);

export function parseSitePagePath(path: string): SitePage | null {
  const match = /^\/podcasts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(?:page\/([1-9][0-9]*)\/|([a-f0-9]{16}(?:[a-f0-9]{4}){0,12})\/)?$/.exec(path);
  if (!match || match[1].length > 32) return null;
  if (match[3]) return { kind: "episode", showId: match[1], siteId: match[3] };
  const page = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isSafeInteger(page) || page < 1 || match[2] && page === 1) return null;
  return { kind: "listing", showId: match[1], page };
}

export function sitePagePath(page: SitePage): string {
  const root = `/podcasts/${validateId(page.showId, "show")}/`;
  if (page.kind === "episode") {
    if (!SITE_ID_PATTERN.test(page.siteId)) throw new Error("Invalid Episode site ID");
    return `${root}${page.siteId}/`;
  }
  if (!Number.isSafeInteger(page.page) || page.page < 1) throw new Error("Invalid site page number");
  return page.page === 1 ? root : `${root}page/${page.page}/`;
}

export function sitePageUrl(origin: string, page: SitePage): string {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.port || base.origin !== origin) throw new Error("Invalid site public origin");
  return `${origin}${sitePagePath(page)}`;
}

export function siteSnapshotKey(page: SitePage, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid site generation");
  sitePagePath(page);
  const file = page.kind === "episode" ? `episodes/${page.siteId}.html` : page.page === 1 ? "index.html" : `page/${page.page}.html`;
  return `public/podcasts/${page.showId}/sites/${generation}/${file}`;
}
