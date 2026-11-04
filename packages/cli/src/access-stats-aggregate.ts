import { ACCESS_STATS_FORMAT } from "../../shared/src/access-stats";
import type { AccessStatsDaily, AccessStatsEvent } from "../../shared/src/access-stats";

export function aggregateAccessStats(events: Iterable<AccessStatsEvent>): AccessStatsDaily[] {
  const seen = new Set<string>();
  const groups = new Map<string, { daily: AccessStatsDaily; cacheStatuses: Map<string, number> }>();
  for (const event of events) {
    const dateUtc = new Date(event.occurred_at_ms).toISOString().slice(0, 10);
    const eventKey = JSON.stringify([event.source_id, dateUtc, event.event_id]);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const groupKey = JSON.stringify([event.source_id, event.show_id, dateUtc, event.resource_path]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { daily: {
        format: ACCESS_STATS_FORMAT,
        source_id: event.source_id,
        date_utc: dateUtc,
        show_id: event.show_id,
        resource_path: event.resource_path,
        resource_kind: event.resource_kind,
        episode_id: event.episode_id,
        audio_revision_id: event.audio_revision_id,
        counters: { get_200_requests: 0, get_206_requests: 0, head_requests: 0,
          not_modified_requests: 0, response_bytes: 0, cache_status_requests: {} },
      }, cacheStatuses: new Map() };
      groups.set(groupKey, group);
    }
    const counters = group.daily.counters;
    if (event.method === "HEAD") counters.head_requests++;
    else if (event.status === 304) counters.not_modified_requests++;
    else {
      if (event.status === 200) counters.get_200_requests++;
      else counters.get_206_requests++;
      counters.response_bytes += event.response_bytes;
    }
    const cacheStatus = event.cache_status ?? "unavailable";
    group.cacheStatuses.set(cacheStatus, (group.cacheStatuses.get(cacheStatus) ?? 0) + 1);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => ({
    ...group.daily,
    counters: { ...group.daily.counters, cache_status_requests: Object.fromEntries(
      [...group.cacheStatuses].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) },
  }));
}
