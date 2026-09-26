import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { canonicalEnclosureUrl } from "./media-url";

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character] ?? character);
}

function renderItem(episode: EpisodeRevision, showId: string, baseUrl: string): string {
  const hours = Math.floor(episode.duration_seconds / 3600);
  const minutes = Math.floor(episode.duration_seconds % 3600 / 60);
  const seconds = episode.duration_seconds % 60;
  const duration = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return `    <item>\n` +
    `      <title>${escapeXml(episode.title)}</title>\n` +
    `      <description>${escapeXml(episode.description)}</description>\n` +
    `      <guid isPermaLink="false">${escapeXml(episode.guid)}</guid>\n` +
    `      <pubDate>${new Date(episode.published_at).toUTCString()}</pubDate>\n` +
    `      <enclosure url="${escapeXml(canonicalEnclosureUrl(episode, showId, baseUrl))}" length="${episode.length_bytes}" type="audio/mpeg" />\n` +
    `      <itunes:duration>${duration}</itunes:duration>\n` +
    (episode.episode_type ? `      <itunes:episodeType>${episode.episode_type}</itunes:episodeType>\n` : "") +
    (episode.season_number ? `      <itunes:season>${episode.season_number}</itunes:season>\n` : "") +
    (episode.episode_number ? `      <itunes:episode>${episode.episode_number}</itunes:episode>\n` : "") +
    (episode.explicit !== undefined ? `      <itunes:explicit>${episode.explicit}</itunes:explicit>\n` : "") +
    `    </item>\n`;
}

export function renderFeed(show: ShowMetadata, episodes: EpisodeRevision[],
  baseUrl: string, coverExtension: string): string {
  const coverUrl = `${baseUrl.replace(/\/$/, "")}/podcasts/${show.show_id}/cover.${coverExtension}`;
  const feedUrl = `${baseUrl.replace(/\/$/, "")}/podcasts/${show.show_id}/feed.xml`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" ` +
    `xmlns:content="http://purl.org/rss/1.0/modules/content/" ` +
    `xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />\n` +
    `    <title>${escapeXml(show.title)}</title>\n` +
    `    <link>${escapeXml(show.site_url)}</link>\n` +
    `    <description>${escapeXml(show.description)}</description>\n` +
    `    <language>${escapeXml(show.language)}</language>\n` +
    `    <itunes:author>${escapeXml(show.author)}</itunes:author>\n` +
    `    <itunes:explicit>${show.explicit ? "true" : "false"}</itunes:explicit>\n` +
    `    <itunes:owner><itunes:name>${escapeXml(show.owner_name)}</itunes:name>` +
    `<itunes:email>${escapeXml(show.owner_email)}</itunes:email></itunes:owner>\n` +
    show.categories.map((category) => `    <itunes:category text="${escapeXml(category)}" />\n`).join("") +
    (show.copyright ? `    <copyright>${escapeXml(show.copyright)}</copyright>\n` : "") +
    (show.show_type ? `    <itunes:type>${show.show_type}</itunes:type>\n` : "") +
    `    <image><url>${escapeXml(coverUrl)}</url><title>${escapeXml(show.title)}</title>` +
    `<link>${escapeXml(show.site_url)}</link></image>\n` +
    `    <itunes:image href="${escapeXml(coverUrl)}" />\n` +
    episodes.toSorted((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at) ||
      left.episode_id.localeCompare(right.episode_id)).map((episode) =>
        renderItem(episode, show.show_id, baseUrl)).join("") +
    `  </channel>\n</rss>\n`;
}
