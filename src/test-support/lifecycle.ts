import { stringifyLifecycleToml } from "../../packages/shared/src/index";
import type { ControlRequest } from "../../packages/shared/src/index";
import { claimShowOperation } from "../lifecycle-control";

export async function lifecycleFixture(options: { kind?: "show" | "episode"; action?: ControlRequest["action"] } = {}) {
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
    async list(options: { prefix: string; cursor?: string; limit: number }) {
      const matching = [...entries].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => ({ key, etag: entry.etag, size: entry.size }));
      const offset = Number(options.cursor ?? 0);
      return { objects: matching.slice(offset, offset + options.limit), truncated: offset + options.limit < matching.length,
        cursor: String(offset + options.limit) };
    },
    async delete(input: string | string[]) { for (const key of typeof input === "string" ? [input] : input) entries.delete(key); },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const kind = options.kind ?? "show";
  const action = options.action ?? "unpublish";
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: kind === "show" && action === "restore" ? "unpublished" : "active", generation: 0, feed_generation: 0 }));
  if (kind === "episode") await bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({
    schema_version: 1, show_id: "daily", episode_id: "first", lifecycle: action === "restore" ? "unpublished" : "active", generation: 0,
  }));
  const jobId = crypto.randomUUID();
  const request: ControlRequest = { schema_version: 1, kind, action, job_id: jobId, show_id: "daily", expected_show_generation: 0,
    created_at: "2026-10-01T12:00:00Z", ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}) };
  await claimShowOperation(env, request);
  const operation = { showId: "daily", jobId, generation: 1 };
  return { bucket, env, entries, writes, request, operation, jobId };
}
