import { episodeRevisionSchema, stringifyToml } from "../../packages/shared/src/index";
import { claimServiceMigration, initializeServiceAdmission, pauseServiceAdmission, readServiceAdmission } from "../service-admission";
import { PUBLICATION_SERVICE_TEXT, PUBLICATION_SHOW_TEXT } from "./publication";
import type { MigrationApplyEffects } from "../lifecycle-migration-apply";

export async function migrationFixture(pageSize = 1000) {
  const entries = new Map<string, { data: string; size: number; etag: string }>();
  const writes: string[] = [];
  let version = 0;
  const bucket = {
    async get(key: string) {
      const entry = entries.get(key);
      return entry ? { key, ...entry, text: async () => entry.data, json: async () => JSON.parse(entry.data) } : null;
    },
    async head(key: string) { const entry = entries.get(key); return entry ? { key, ...entry } : null; },
    async put(key: string, data: string, options?: { onlyIf?: Headers | { etagMatches: string } }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && previous?.etag !== options.onlyIf.etagMatches) return null;
      const etag = String(++version);
      entries.set(key, { data, size: new TextEncoder().encode(data).length, etag });
      writes.push(key);
      return { key, etag };
    },
    async list(options: { prefix?: string; cursor?: string; limit: number }) {
      const objects = [...entries].filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => ({ key, etag: entry.etag, size: entry.size }));
      const offset = Number(options.cursor ?? 0);
      const limit = Math.min(pageSize, options.limit);
      return { objects: objects.slice(offset, offset + limit), truncated: offset + limit < objects.length, cursor: String(offset + limit) };
    },
    async delete(input: string | string[]) {
      for (const key of typeof input === "string" ? [input] : input) entries.delete(key);
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const jobId = crypto.randomUUID();
  await bucket.put("system/service.toml", PUBLICATION_SERVICE_TEXT);
  await bucket.put("system/show-reservations/daily.json", JSON.stringify({ show_id: "daily", reservation_id: crypto.randomUUID() }));
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ job_id: jobId, state: "free" }));
  await bucket.put(`system/jobs/${jobId}/status.toml`, stringifyToml({ schema_version: 1, job_id: jobId,
    show_id: "daily", kind: "show", state: "published" }));
  await bucket.put("system/shows/daily/show.toml", PUBLICATION_SHOW_TEXT);
  await bucket.put("public/podcasts/daily/feed.xml", "legacy feed");
  await bucket.put("public/podcasts/daily/cover.jpg", "cover");
  const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: "first", guid: crypto.randomUUID(),
    revision_id: crypto.randomUUID(), title: "Private episode", description: "Private description", published_at: "2026-09-30T12:00:00Z",
    enclosure_url: `https://current.example/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`, content_type: "audio/mpeg",
    length_bytes: 5, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-09-30T12:00:00Z" });
  await bucket.put(`public${new URL(revision.enclosure_url).pathname}`, "audio");
  await bucket.put("public/episodes/daily/first/metadata.toml", stringifyToml(revision));
  await bucket.put(`public/episodes/daily/first/revisions/${revision.revision_id}.toml`, stringifyToml(revision));
  await initializeServiceAdmission(env, "service");
  const pauseId = crypto.randomUUID();
  const migrationId = crypto.randomUUID();
  await pauseServiceAdmission(env, "service", pauseId);
  await claimServiceMigration(env, { schema_version: 1, service_id: "service", migration_id: migrationId, pause_id: pauseId,
    expected_service_generation: (await readServiceAdmission(env, "service"))!.value.generation, created_at: "2026-10-01T12:00:00Z" });
  const runtime = { deployment_id: crypto.randomUUID(), worker_version_id: crypto.randomUUID(), default_cache_disabled: true as const,
    cached_entrypoint: "CachedPublicAssets" as const, old_cache_purged: true as const, cutover_verified: true as const,
    old_io_quiesced: true as const, publication_routes_verified: true as const };
  const effects: MigrationApplyEffects = { checkQuiescence: async () => {}, verifyCutover: async () => runtime };
  return { env, bucket, entries, writes, jobId, pauseId, migrationId, runtime, effects,
    prefix: `system/lifecycle-migrations/${migrationId}` };
}
