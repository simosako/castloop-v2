import { z } from "zod";
import { diagnosticCheckSchema, diagnosticSummarySchema, parseEpisodeDraft, PUBLICATION_RENDER_BUDGET_BYTES,
  sqliteServiceConfigSchema, validateId } from "@castloop/shared";
import type { DiagnosticCheck, DiagnosticSummary, SqliteServiceConfig } from "@castloop/shared";
import { publicRequest, PublicHttpError } from "./public-http";
import type { PublicRequestOptions } from "./public-http";
import { createLocalJournalStorage } from "./local-journal-storage";
import { ensureLocalJournalParents } from "./local-journal-path";
import { readLocalMetadata } from "./local-metadata-read";
import type { R2RestTransport } from "./verified-r2-put";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const verifyResultSchema = z.object({
  schema_version: z.literal(1),
  show_id: z.string().max(32),
  episode_id: z.string().max(80).optional(),
  checks: z.array(diagnosticCheckSchema).max(8),
  summary: diagnosticSummarySchema,
  processing: z.object({ state: z.enum(["succeeded", "not_checked"]), detail: z.string().max(200) }).strict(),
}).strict();
export type VerifyResult = z.infer<typeof verifyResultSchema>;

type EpisodeEvidence = { episodeId: string; guid: string | null; published: boolean; audioLength: number | null; audioEtag: string | null };

const journalBrief = z.object({
  target: z.object({ job_id: z.uuid(), kind: z.enum(["show", "episode"]), show_id: z.string(), episode_id: z.string().optional() }),
  assets: z.array(z.object({ upload: z.object({ asset: z.string(), length_bytes: z.number() }) })).max(2),
  publication: z.object({ status: z.object({ state: z.string() }).optional() }).optional(),
});

function summarize(checks: DiagnosticCheck[]): DiagnosticSummary {
  const summary = { pass: 0, warn: 0, fail: 0, not_checked: 0 };
  for (const entry of checks) summary[entry.status] += 1;
  return summary;
}

function localEvidence(root: string, config: SqliteServiceConfig, showId: string): { showPublished: boolean; episodes: Map<string, EpisodeEvidence> } {
  const episodes = new Map<string, EpisodeEvidence>();
  let showPublished = false;
  for (const family of ["sqlite-drafts", "sqlite-publications"] as const) {
    ensureLocalJournalParents(root, family, config.service_id);
    let names: string[] = [];
    try {
      names = readdirSync(join(root, ".castloop", family, config.service_id)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (names.length > 10000) throw new Error("Local journal lookup exceeds its record budget");
    for (const name of names) {
      const parsed = journalBrief.safeParse(createLocalJournalStorage(root, family, config.service_id, name).read());
      if (!parsed.success || parsed.data.target.show_id !== showId) continue;
      const brief = parsed.data;
      const succeeded = brief.publication?.status?.state === "succeeded";
      if (brief.target.kind === "show" && succeeded) showPublished = true;
      if (brief.target.kind === "episode" && brief.target.episode_id !== undefined) {
        const existing = episodes.get(brief.target.episode_id) ?? { episodeId: brief.target.episode_id, guid: null, published: false, audioLength: null, audioEtag: null };
        if (succeeded) existing.published = true;
        const audio = brief.assets.find((asset) => asset.upload.asset === "audio");
        if (succeeded && audio && existing.audioLength === null) existing.audioLength = audio.upload.length_bytes;
        episodes.set(brief.target.episode_id, existing);
      }
    }
  }
  return { showPublished, episodes };
}

async function localEpisodeGuids(root: string, showId: string): Promise<Map<string, string>> {
  const guids = new Map<string, string>();
  const directory = join(root, showId);
  if (!existsSync(directory)) return guids;
  for (const name of readdirSync(directory)) {
    if (!/^episode-[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/.test(name)) continue;
    const draft = parseEpisodeDraft((await readLocalMetadata(join(directory, name), 1000000)).toString("utf8"));
    guids.set(draft.episode_id, draft.guid);
  }
  return guids;
}

type FeedItem = { guid: string | null; enclosure: string | null };

function parseFeed(source: string): { image: string | null; items: FeedItem[] } | null {
  if (!/<rss[\s>]/.test(source) || !/<channel>/.test(source)) return null;
  const image = (/<itunes:image[^>]*href="([^"]+)"/.exec(source) ?? [])[1] ?? null;
  const items = [...source.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const item = match[1]!;
    const rawGuid = (/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(item) ?? [])[1] ?? null;
    const guid = rawGuid === null ? null : rawGuid.replace("<![CDATA[", "").replace("]]>", "").trim();
    return { guid, enclosure: (/<enclosure[^>]*url="([^"]+)"/.exec(item) ?? [])[1] ?? null };
  });
  return { image, items };
}

async function headWithRangeFallback(url: URL, options: PublicRequestOptions): Promise<{ status: number; contentLength: number | null; etag: string | null; contentType: string | null; redirects: string[] }> {
  try {
    const response = await publicRequest(url, "HEAD", options);
    if (response.status === 200 && response.contentLength === null) {
      return await rangeTotal(url, options, response.redirects);
    }
    return { status: response.status, contentLength: response.contentLength, etag: response.etag, contentType: response.contentType, redirects: response.redirects };
  } catch (error) {
    if (error instanceof PublicHttpError && error.code === "transport_error") return await rangeTotal(url, options, []);
    throw error;
  }
}

async function rangeTotal(url: URL, options: PublicRequestOptions, redirects: string[]): Promise<{ status: number; contentLength: number | null; etag: string | null; contentType: string | null; redirects: string[] }> {
  const response = await publicRequest(url, "GET", { ...options, maximumBytes: 1, timeoutMs: options.timeoutMs });
  return { status: response.status, contentLength: response.contentLength, etag: response.etag, contentType: response.contentType, redirects };
}

export async function collectDeliveryChecks(root: string, config: SqliteServiceConfig, showId: string,
  episodeId: string | undefined, transport?: R2RestTransport): Promise<{ checks: DiagnosticCheck[]; processing: VerifyResult["processing"] }> {
  const options: PublicRequestOptions = { transport };
  const evidence = localEvidence(root, config, showId);
  const guids = await localEpisodeGuids(root, showId);
  for (const [episode, guid] of guids) {
    const existing = evidence.episodes.get(episode);
    if (existing) existing.guid = guid;
    else evidence.episodes.set(episode, { episodeId: episode, guid, published: false, audioLength: null, audioEtag: null });
  }
  const feedUrl = new URL(`/podcasts/${showId}/feed.xml`, config.public_base_url);
  const checks: DiagnosticCheck[] = [];
  let feedXml: string | null = null;
  try {
    const response = await publicRequest(feedUrl, "GET", { ...options, maximumBytes: PUBLICATION_RENDER_BUDGET_BYTES });
    if (response.status === 200) {
      checks.push({ id: "feed-status", scope: "external", status: "pass", code: "feed_served",
        message: `The public feed is served${response.redirects.length ? ` after ${response.redirects.length} redirect(s)` : ""}`, next_actions: [] });
      feedXml = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(response.body ?? new Uint8Array());
    } else if (response.status === 503) {
      checks.push({ id: "feed-status", scope: "external", status: "warn", code: "feed_unavailable",
        message: "The feed returned 503; Show delivery is stopped or unavailable (inspect with diagnose)", next_actions: [] });
    } else if (response.status === 404) {
      checks.push(evidence.showPublished
        ? { id: "feed-status", scope: "external", status: "fail", code: "published_feed_missing",
          message: "The Show has a local succeeded publication but the feed is absent", next_actions: [] }
        : { id: "feed-status", scope: "external", status: "warn", code: "feed_absent_no_publication_evidence",
          message: "The feed is absent and no local succeeded publication exists for the Show", next_actions: [] });
    } else {
      checks.push({ id: "feed-status", scope: "external", status: "fail", code: "unexpected_status",
        message: `The feed returned HTTP ${response.status}`, next_actions: [] });
    }
  } catch (error) {
    const code = error instanceof PublicHttpError ? error.code : "transport_error";
    checks.push({ id: "feed-status", scope: "external", status: "fail", code: `feed_${code}`.replace(/[^a-z_]/g, ""),
      message: `The feed request failed (${code})`, next_actions: [] });
  }

  const feed = feedXml === null ? null : parseFeed(feedXml);
  const publishedOrigin = new URL(config.public_base_url).origin;
  const publishedEpisodes = [...evidence.episodes.values()].filter((episode) => episode.published && episode.guid !== null);
  if (feed === null) {
    checks.push({ id: "feed-content", scope: "external", status: feedXml === null ? "not_checked" : "fail",
      code: feedXml === null ? "feed_not_fetched" : "feed_parse_failed",
      message: feedXml === null ? "The feed was not fetched; content checks were skipped" : "The feed body did not parse as RSS", next_actions: [] });
  } else if (!publishedEpisodes.length) {
    checks.push({ id: "feed-content", scope: "external", status: "not_checked", code: "no_local_expectations",
      message: "The feed parsed but no local succeeded episode publications exist for comparison", next_actions: [] });
  } else {
    const missing = publishedEpisodes.filter((episode) => !feed.items.some((item) => item.guid === episode.guid));
    const originMismatch = feed.items.some((item) => item.enclosure !== null && new URL(item.enclosure).origin !== publishedOrigin);
    if (missing.length) {
      checks.push({ id: "feed-content", scope: "external", status: "fail", code: "guid_missing",
        message: `Feed is missing GUIDs of locally succeeded episodes: ${missing.map((episode) => episode.episodeId).join(", ")}`, next_actions: [] });
    } else if (originMismatch) {
      checks.push({ id: "feed-content", scope: "external", status: "fail", code: "enclosure_origin_mismatch",
        message: "Feed enclosure URLs do not use the configured public origin", next_actions: [] });
    } else {
      checks.push({ id: "feed-content", scope: "external", status: "pass", code: "feed_content_verified",
        message: `Feed structure, enclosure origins and ${publishedEpisodes.length} known episode GUID(s) are verified`, next_actions: [] });
    }
  }

  if (feed?.image) {
    try {
      const cover = await headWithRangeFallback(new URL(feed.image, config.public_base_url), options);
      checks.push(cover.status === 200
        ? { id: "cover", scope: "external", status: "pass", code: "cover_served",
          message: `The published cover is served${cover.redirects.length ? ` after ${cover.redirects.length} redirect(s)` : ""}`, next_actions: [] }
        : { id: "cover", scope: "external", status: "fail", code: "cover_missing",
          message: `The published cover returned HTTP ${cover.status}`, next_actions: [] });
    } catch {
      checks.push({ id: "cover", scope: "external", status: "fail", code: "cover_unreachable",
        message: "The published cover request failed", next_actions: [] });
    }
  } else {
    checks.push({ id: "cover", scope: "external", status: "not_checked", code: "cover_url_unknown",
      message: "No cover URL is known from the feed; the cover was not checked", next_actions: [] });
  }

  if (episodeId === undefined) {
    checks.push({ id: "audio", scope: "external", status: "not_checked", code: "audio_not_requested",
      message: "Audio was not checked; request it with --episode EPISODE_ID", next_actions: [] });
  } else {
    const target = evidence.episodes.get(episodeId);
    const enclosure = target?.guid ? feed?.items.find((item) => item.guid === target.guid)?.enclosure ?? null : null;
    if (!enclosure) {
      checks.push({ id: "audio", scope: "external", status: target?.published ? "fail" : "not_checked",
        code: target?.published ? "audio_url_missing" : "audio_no_local_expectation",
        message: target?.published ? "The published episode has no enclosure URL in the feed" : "No local succeeded publication exists for the Episode", next_actions: [] });
    } else {
      try {
        const audio = await headWithRangeFallback(new URL(enclosure), options);
        if (audio.status !== 200) {
          checks.push({ id: "audio", scope: "external", status: "fail", code: "audio_missing",
            message: `The published audio returned HTTP ${audio.status}`, next_actions: [] });
        } else if (target?.audioLength !== null && target !== undefined && audio.contentLength !== null && audio.contentLength !== target.audioLength) {
          checks.push({ id: "audio", scope: "external", status: "fail", code: "audio_content_mismatch",
            message: `Published audio length ${audio.contentLength} differs from the staged ${target.audioLength}`, next_actions: [] });
        } else {
          checks.push({ id: "audio", scope: "external", status: "pass", code: "audio_served",
            message: `The published audio is served${target?.audioLength === null ? " (length comparison not checked)" : ""}`, next_actions: [] });
        }
      } catch {
        checks.push({ id: "audio", scope: "external", status: "fail", code: "audio_unreachable",
          message: "The published audio request failed", next_actions: [] });
      }
    }
  }

  const unpublished = [...evidence.episodes.values()].filter((episode) => !episode.published && episode.guid !== null);
  if (feed === null) {
    checks.push({ id: "unpublished-episodes", scope: "external", status: "not_checked", code: "feed_not_fetched",
      message: "The feed was not fetched; unpublished episode linkage was not checked", next_actions: [] });
  } else if (!unpublished.length) {
    checks.push({ id: "unpublished-episodes", scope: "external", status: "pass", code: "no_unpublished_episodes",
      message: "No locally unpublished episodes exist", next_actions: [] });
  } else {
    const linked = unpublished.filter((episode) => feed.items.some((item) => item.guid === episode.guid));
    checks.push(linked.length
      ? { id: "unpublished-episodes", scope: "external", status: "warn", code: "linked_without_publication_evidence",
        message: `Episodes without local succeeded publication appear in the feed: ${linked.map((episode) => episode.episodeId).join(", ")}`, next_actions: [] }
      : { id: "unpublished-episodes", scope: "external", status: "pass", code: "unpublished_not_linked",
        message: `${unpublished.length} unpublished episode(s) are correctly absent from the feed`, next_actions: [] });
  }

  const processingTarget = episodeId === undefined ? evidence.showPublished : evidence.episodes.get(episodeId)?.published ?? false;
  return { checks, processing: processingTarget
    ? { state: "succeeded", detail: "local journals record a succeeded publication for this target" }
    : { state: "not_checked", detail: "no local succeeded publication exists for this target" } };
}

export async function verifyShowDelivery(root: string, input: SqliteServiceConfig, showId: string,
  episodeId: string | undefined, transport?: R2RestTransport): Promise<VerifyResult> {
  const config = sqliteServiceConfigSchema.parse(input);
  const { checks, processing } = await collectDeliveryChecks(root, config, validateId(showId, "show"),
    episodeId === undefined ? undefined : validateId(episodeId, "episode"), transport);
  return verifyResultSchema.parse({ schema_version: 1, show_id: showId, ...(episodeId !== undefined ? { episode_id: episodeId } : {}),
    checks, summary: summarize(checks), processing });
}

export function formatVerify(result: VerifyResult): string {
  const labels = { pass: "PASS", warn: "WARN", fail: "FAIL", not_checked: "SKIP" } as const;
  const lines = [`Delivery checks for ${result.show_id}${result.episode_id === undefined ? "" : `/${result.episode_id}`}:`,
    `Processing: ${result.processing.state}${result.processing.detail ? ` — ${result.processing.detail}` : ""}`];
  lines.push(...result.checks.map((entry) => `${labels[entry.status].padEnd(5)} ${entry.id.padEnd(24)} ${entry.message}`));
  lines.push(`Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail, ${result.summary.not_checked} not checked`);
  return lines.join("\n");
}
