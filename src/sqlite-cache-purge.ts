import { validateId } from "../packages/shared/src/index";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";

export type SqliteCachePurgeEvent = { event: "sqlite_cache_purge"; show_id: string; episode_id?: string;
  reason_code: "purge_rate_limited" | "purge_rejected" | "purge_unconfirmed"; attempt: number; will_retry: boolean };
type PurgeOptions = { delay?: (milliseconds: number) => Promise<void>; onEvent?: (event: SqliteCachePurgeEvent) => void };
const MAX_ATTEMPTS = 6;
const RETRY_WAIT_MS = 12000;

export async function purgeSqliteCache(cache: Pick<CacheContext, "purge"> | undefined, input: LifecyclePurgeTarget,
  options: PurgeOptions = {}): Promise<void> {
  const showId = validateId(input.showId, "show");
  const episodeId = input.episodeId === undefined ? undefined : validateId(input.episodeId, "episode");
  if (!cache) throw new Error("SQLite cached entrypoint purge is unavailable");
  const target: CachePurgeOptions = {
    tags: episodeId ? [`feed-${showId}`, `episode-${showId}/${episodeId}`] : [`show-${showId}`, `feed-${showId}`, `cover-${showId}`],
    pathPrefixes: [episodeId ? `/podcasts/${showId}/episodes/${episodeId}/` : `/podcasts/${showId}/`],
  };
  const emit = (reasonCode: SqliteCachePurgeEvent["reason_code"], attempt: number, willRetry: boolean) => {
    const event: SqliteCachePurgeEvent = { event: "sqlite_cache_purge", show_id: showId,
      ...(episodeId === undefined ? {} : { episode_id: episodeId }), reason_code: reasonCode, attempt, will_retry: willRetry };
    if (options.onEvent) options.onEvent(event);
    else console.error(JSON.stringify(event));
  };
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: CachePurgeResult;
    try { result = await cache.purge(target); }
    catch {
      emit("purge_unconfirmed", attempt, false);
      throw new Error("SQLite cache purge outcome is unconfirmed; do not replay publication");
    }
    if (result?.success === true) return;
    if (result?.success !== false) {
      emit("purge_unconfirmed", attempt, false);
      throw new Error("SQLite cache purge acknowledgement is unconfirmed");
    }
    const rateLimited = Array.isArray(result.errors) && result.errors.length > 0 && result.errors.length <= 10 &&
      result.errors.every((error) => typeof error?.message === "string" &&
        /rate[\s_-]*limit|too many (?:requests|purges)/i.test(error.message.slice(0, 1024)));
    const retry = rateLimited && attempt < MAX_ATTEMPTS;
    emit(rateLimited ? "purge_rate_limited" : "purge_rejected", attempt, retry);
    if (!rateLimited) throw new Error("SQLite cache purge was rejected without a verified rate limit");
    if (retry) await delay(RETRY_WAIT_MS);
  }
  throw new Error("SQLite cache purge was rejected after bounded waiting");
}
