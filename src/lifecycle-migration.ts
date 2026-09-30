import { z } from "zod";
import { episodeCommitSchema, parseEpisodeLifecycle, parseEpisodeRevision, parseJobStatus, parseServiceConfig,
  parseShowControl, parseShowMetadata, showCommitSchema, validateId } from "../packages/shared/src/index";
import type { EpisodeLifecycle, ShowControl } from "../packages/shared/src/index";

export type MigrationSource = { key: string; etag: string; size: number };
export type MigrationBlocker = { code: string; key: string; message: string };
export type EpisodeMigrationPlan = { episode_id: string; mode: "initialize" | "preserve"; value: EpisodeLifecycle };
export type ShowMigrationPlan = { show_id: string; mode: "initialize" | "preserve";
  value: ShowControl; episodes: EpisodeMigrationPlan[] };
export type LifecycleMigrationPlan = {
  schema_version: 1;
  target_show_schema_version: 2;
  requires_quiescence: true;
  inventory_compatible: boolean;
  blockers: MigrationBlocker[];
  sources: MigrationSource[];
  shows: ShowMigrationPlan[];
};
export type MigrationReadEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "list" | "get"> };

const legacyAdmissionSchema = z.object({ job_id: z.uuid(), state: z.enum(["reserved", "processing", "free"]) }).strict();
const reservationSchema = z.object({ show_id: z.string(), reservation_id: z.uuid() }).strict();
const MAX_RECORD_BYTES = 1_000_000;

async function inventory(env: MigrationReadEnv, maximumObjects: number): Promise<Map<string, MigrationSource>> {
  const objects = new Map<string, MigrationSource>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await env.CASTLOOP_BUCKET.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      if (objects.has(object.key)) throw new Error("Migration inventory changed or contains duplicate object keys");
      objects.set(object.key, { key: object.key, etag: object.etag, size: object.size });
      if (objects.size > maximumObjects) throw new Error("Migration inventory exceeds its object limit; use a batched migration plan");
    }
    if (!page.truncated) return objects;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Migration inventory has an invalid pagination cursor");
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
}

export async function planLifecycleMigration(env: MigrationReadEnv,
  options: { maximumObjects?: number } = {}): Promise<LifecycleMigrationPlan> {
  const maximum = options.maximumObjects ?? 10000;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 100000) throw new Error("Invalid migration object limit");
  const objects = await inventory(env, maximum);
  const blockers: MigrationBlocker[] = [];
  const shows = new Map<string, Set<string>>();
  function block(code: string, key: string, message: string): void { blockers.push({ code, key, message }); }
  function hasPrefix(prefix: string): boolean { return [...objects.keys()].some((key) => key.startsWith(prefix)); }
  function target(showId: string, key: string, episodeId?: string): void {
    try {
      validateId(showId, "show");
      if (episodeId !== undefined) validateId(episodeId, "episode");
    } catch { block("invalid_target_key", key, "Object key contains an invalid Show or Episode ID"); return; }
    if (!shows.has(showId)) shows.set(showId, new Set());
    if (episodeId !== undefined) shows.get(showId)!.add(episodeId);
  }
  async function record<T>(key: string, parse: (text: string) => T): Promise<T | null> {
    const listed = objects.get(key);
    if (!listed) return null;
    if (listed.size > MAX_RECORD_BYTES) { block("record_too_large", key, "Metadata exceeds the inventory record size limit"); return null; }
    const object = await env.CASTLOOP_BUCKET.get(key);
    if (!object || object.etag !== listed.etag || object.size !== listed.size) {
      throw new Error(`Migration source changed during inventory: ${key}`);
    }
    const text = await object.text();
    try { return parse(text); }
    catch { block("invalid_record", key, "Stored record failed strict schema validation"); return null; }
  }
  for (const key of objects.keys()) {
    const parts = key.split("/");
    if (key.startsWith("system/show-reservations/") || key.startsWith("system/show-publications/")) {
      if (parts.length === 3 && parts[2].endsWith(".json")) target(parts[2].slice(0, -5), key);
      else block("invalid_target_key", key, "Malformed Show control or reservation key");
    } else if (key.startsWith("system/shows/")) {
      if (parts.length === 4 && parts[3] === "show.toml") target(parts[2], key);
      else block("invalid_target_key", key, "Unexpected system Show object");
    } else if (key.startsWith("public/episodes/")) {
      if ((parts.length === 5 && parts[4] === "metadata.toml") ||
        (parts.length === 6 && parts[4] === "revisions" && parts[5].endsWith(".toml") &&
          z.uuid().safeParse(parts[5].slice(0, -5)).success)) target(parts[2], key, parts[3]);
      else block("invalid_target_key", key, "Malformed published Episode metadata key");
    } else if (key.startsWith("system/episode-lifecycle/")) {
      if (parts.length === 4 && parts[3].endsWith(".toml")) target(parts[2], key, parts[3].slice(0, -5));
      else block("invalid_target_key", key, "Malformed Episode lifecycle key");
    } else if (key.startsWith("public/podcasts/")) {
      if (parts.length === 4 && /^(feed\.xml|cover\.(jpg|png))$/.test(parts[3])) target(parts[2], key);
      else if (parts.length === 6 && parts[3] === "episodes" && z.uuid().safeParse(parts[5].replace(/\.mp3$/, "")).success &&
        parts[5].endsWith(".mp3")) target(parts[2], key, parts[4]);
      else block("invalid_target_key", key, "Malformed published asset key");
    } else if (key.startsWith("staging/lifecycle/")) {
      block("unsupported_lifecycle_stage", key, "Lifecycle staging requires inspection by a migration-aware consumer");
    } else if (key.startsWith("staging/shows/") || key.startsWith("staging/episodes/")) {
      const episode = parts[1] === "episodes";
      const expectedLength = episode ? 6 : 5;
      const jobId = parts[episode ? 4 : 3];
      if (parts.length !== expectedLength || !z.uuid().safeParse(jobId).success ||
        !(episode ? /^(episode\.toml|audio\.mp3|commit\.json)$/ : /^(show\.toml|cover\.(jpg|png)|commit\.json)$/).test(parts.at(-1)!)) {
        block("invalid_target_key", key, "Malformed staging draft key");
        continue;
      }
      target(parts[2], key, episode ? parts[3] : undefined);
      if (parts.at(-1) === "commit.json") {
        const commit = await record(key, (text) => episode ? episodeCommitSchema.parse(JSON.parse(text)) : showCommitSchema.parse(JSON.parse(text)));
        if (commit && (commit.show_id !== parts[2] || commit.job_id !== jobId ||
          commit.kind === "episode" && commit.episode_id !== parts[3])) block("target_mismatch", key, "Commit target does not match its key");
        const status = await record(`system/jobs/${jobId}/status.toml`, parseJobStatus);
        if (!status || status.state !== "published") block("unfinished_commit", key, "Committed legacy publication has not completed");
        else if (status.job_id !== jobId || status.show_id !== parts[2] || status.kind !== (episode ? "episode" : "show") ||
          status.episode_id !== (episode ? parts[3] : undefined)) block("target_mismatch", key, "Job status does not match its commit target");
      }
    }
  }
  if (!await record("system/service.toml", parseServiceConfig)) {
    block("missing_service", "system/service.toml", "A valid published service config is required");
  }
  const plans: ShowMigrationPlan[] = [];
  for (const [showId, episodeIds] of [...shows].sort(([left], [right]) => left.localeCompare(right))) {
    const reservationKey = `system/show-reservations/${showId}.json`;
    const reservation = await record(reservationKey, (text) => reservationSchema.parse(JSON.parse(text)));
    if (!reservation) block("missing_reservation", reservationKey, "Discovered Show has no valid reservation");
    else if (reservation.show_id !== showId) block("target_mismatch", reservationKey, "Show reservation does not match its key");
    const showKey = `system/shows/${showId}/show.toml`;
    const metadata = await record(showKey, parseShowMetadata);
    if (metadata && metadata.show_id !== showId) block("target_mismatch", showKey, "Show metadata does not match its key");
    if (metadata) {
      const feedKey = `public/podcasts/${showId}/feed.xml`;
      if (!objects.get(feedKey)?.size) block("missing_feed", feedKey, "Published Show has no nonempty feed");
      const extension = metadata.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
      const coverKey = `public/podcasts/${showId}/cover.${extension}`;
      if (!objects.get(coverKey)?.size) block("missing_cover", coverKey, "Published Show has no nonempty cover");
    } else if (hasPrefix(`public/podcasts/${showId}/`)) {
      block("orphan_public_assets", showKey, "Published assets exist without valid Show metadata");
    }
    const controlKey = `system/show-publications/${showId}.json`;
    const admission = await record(controlKey, (text) => {
      const input: unknown = JSON.parse(text);
      return typeof input === "object" && input !== null && "schema_version" in input
        ? parseShowControl(input) : legacyAdmissionSchema.parse(input);
    });
    const existing = admission && "schema_version" in admission ? admission : null;
    if (existing && existing.show_id !== showId) block("target_mismatch", controlKey, "Show control does not match its key");
    if (metadata && !objects.has(controlKey)) {
      block("missing_publication_record", controlKey, "Published legacy Show is missing its publication admission record");
    }
    if (admission && "state" in admission && admission.state === "free") {
      const statusKey = `system/jobs/${admission.job_id}/status.toml`;
      const status = await record(statusKey, parseJobStatus);
      if (!status || status.job_id !== admission.job_id || status.show_id !== showId || status.state !== "published") {
        block("invalid_completed_owner", statusKey, "Free legacy admission must retain a matching published job status");
      }
    }
    if (existing?.owner || admission && "state" in admission && admission.state !== "free") {
      block("unfinished_owner", controlKey, "Show has an unfinished publication or upload owner");
    }
    if (existing?.lifecycle === "active" && !metadata) {
      block("missing_active_metadata", showKey, "Active Show has no valid published metadata");
    }
    if (existing?.lifecycle === "deleting") block("unfinished_lifecycle", controlKey, "Show deletion must finish before migration");
    if (existing?.lifecycle === "deleted" && (metadata || hasPrefix(`public/podcasts/${showId}/`) ||
      hasPrefix(`public/episodes/${showId}/`) || hasPrefix(`staging/shows/${showId}/`) || hasPrefix(`staging/episodes/${showId}/`))) {
      block("deleted_payload", controlKey, "Deleted Show still has content payloads that require recovery");
    }
    const value: ShowControl = existing ?? { schema_version: 2, show_id: showId,
      lifecycle: metadata ? "active" : "draft", generation: 0, feed_generation: 0 };
    const episodes: EpisodeMigrationPlan[] = [];
    for (const episodeId of [...episodeIds].sort()) {
      const metadataKey = `public/episodes/${showId}/${episodeId}/metadata.toml`;
      const revision = await record(metadataKey, parseEpisodeRevision);
      const lifecycleKey = `system/episode-lifecycle/${showId}/${episodeId}.toml`;
      const lifecycle = await record(lifecycleKey, parseEpisodeLifecycle);
      if (lifecycle && (lifecycle.show_id !== showId || lifecycle.episode_id !== episodeId)) {
        block("target_mismatch", lifecycleKey, "Episode control does not match its key");
      }
      if ((existing && !lifecycle) || (!existing && lifecycle)) {
        block("partial_lifecycle_state", lifecycleKey, "Partial lifecycle initialization requires an owned migration recovery plan");
      }
      if (lifecycle?.lifecycle === "active" && !revision) {
        block("missing_active_metadata", metadataKey, "Active Episode has no valid current metadata");
      }
      if (lifecycle?.lifecycle === "deleting") block("unfinished_lifecycle", lifecycleKey, "Episode deletion must finish before migration");
      if (lifecycle?.lifecycle === "deleted" && (revision || hasPrefix(`public/podcasts/${showId}/episodes/${episodeId}/`) ||
        hasPrefix(`public/episodes/${showId}/${episodeId}/`) || hasPrefix(`staging/episodes/${showId}/${episodeId}/`))) {
        block("deleted_payload", lifecycleKey, "Deleted Episode still has content payloads that require recovery");
      }
      if (revision) {
        if (!metadata) block("orphan_episode", metadataKey, "Published Episode has no valid published parent Show");
        if (revision.episode_id !== episodeId) block("target_mismatch", metadataKey, "Episode metadata does not match its key");
        const url = new URL(revision.enclosure_url);
        const path = new RegExp(`^/podcasts/${showId}/episodes/${episodeId}/([a-f0-9-]{36})\\.mp3$`).exec(url.pathname);
        const audio = path && !url.search ? objects.get(`public${url.pathname}`) : undefined;
        if (!audio || audio.size !== revision.length_bytes || !path || !z.uuid().safeParse(path[1]).success) {
          block("missing_audio", metadataKey, "Episode enclosure path or audio size does not match published metadata");
        }
        const historyKey = `public/episodes/${showId}/${episodeId}/revisions/${revision.revision_id}.toml`;
        const history = await record(historyKey, parseEpisodeRevision);
        if (!history || JSON.stringify(history) !== JSON.stringify(revision)) {
          block("missing_revision", historyKey, "Current Episode revision has no matching immutable history record");
        }
      } else {
        if (!lifecycle || lifecycle.lifecycle === "active") {
          const publishedPrefix = `public/podcasts/${showId}/episodes/${episodeId}/`;
          if (hasPrefix(publishedPrefix) || hasPrefix(`public/episodes/${showId}/${episodeId}/`)) {
            block("orphan_episode", metadataKey, "Episode has published media or history but no valid current metadata");
          }
        }
      }
      episodes.push({ episode_id: episodeId, mode: lifecycle ? "preserve" : "initialize", value: lifecycle ?? {
        schema_version: 1, show_id: showId, episode_id: episodeId,
        lifecycle: revision ? "active" : "draft", generation: 0,
      } });
    }
    plans.push({ show_id: showId, mode: existing ? "preserve" : "initialize", value, episodes });
  }
  return { schema_version: 1, target_show_schema_version: 2, requires_quiescence: true,
    inventory_compatible: blockers.length === 0, blockers, sources: [...objects.values()].sort((left, right) =>
      left.key.localeCompare(right.key)), shows: plans };
}
