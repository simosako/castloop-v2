import { afterEach, expect, test } from "bun:test";
import { setSqliteStatsRetention, formatSqliteStatsDaily, formatSqliteStatsEpisodes } from "./stats";
import type { SqliteStatsEpisodesResponse, SqliteStatsEpisodeDailyResponse } from "../../shared/src/sqlite-stats";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { loadWorkspaceConfig } from "./workspace-config";
import { administratorKey } from "./administrator-key";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { sha256Hex } from "../../shared/src/sha256";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

const runtime = { service_id: "service", worker_version_id: crypto.randomUUID(), service_config_sha256: "a".repeat(64) };
const counters = { get_200_requests: 3, get_206_requests: 5, audio_get_requests: 8, initial_downloads: 2, response_bytes: 1_000_000,
  probe_range_requests: 1, head_requests: 4, not_modified_requests: 2, bot_get_requests: 1, bot_response_bytes: 100, equivalent_full_downloads: 1.25 };

const episodesResponse: SqliteStatsEpisodesResponse = { ...runtime, protocol: "sqlite-sequential-v1", show_id: "daily",
  measurement_started_at_ms: Date.UTC(2026, 9, 10, 4), measurement_started_date_utc: "2026-10-10",
  retained_from_date_utc: "2026-10-10", retention_days: 400, current_date_utc: "2026-10-25",
  recording_error_count: 0, collection_mode: "best_effort_non_blocking",
  from_date_utc: "2026-10-10", to_date_utc: "2026-10-25",
  episodes: [{ episode_id: "first", lifecycle: "published", coverage: "partial", period: counters, lifetime: counters }],
  next_cursor: null };

const dailyResponse: SqliteStatsEpisodeDailyResponse = { ...runtime, protocol: "sqlite-sequential-v1", show_id: "daily",
  episode_id: "first", episode_lifecycle: "published", measurement_started_at_ms: Date.UTC(2026, 9, 10, 4),
  measurement_started_date_utc: "2026-10-10", retained_from_date_utc: "2026-10-10", retention_days: 400,
  current_date_utc: "2026-10-25", recording_error_count: 0, collection_mode: "best_effort_non_blocking",
  from_date_utc: "2026-10-24", to_date_utc: "2026-10-25", coverage: "partial", period: counters, lifetime: counters,
  revisions: [{ audio_revision_id: crypto.randomUUID(), length_bytes: 800_000, is_current_enclosure: true, period: counters, lifetime: counters }],
  days: [{ date_utc: "2026-10-24", coverage: "measured", counters },
    { date_utc: "2026-10-25", coverage: "partial", counters: null },
    { date_utc: "2026-10-20", coverage: "pruned", counters: null } as never],
  next_cursor: null };

test("human-readable statistics tables keep unmeasured and pruned days distinct from zero", () => {
  const episodes = formatSqliteStatsEpisodes(episodesResponse);
  expect(episodes).toContain("Delivery statistics for Show daily (UTC: 2026-10-10 .. 2026-10-25)");
  expect(episodes).toContain("Retention days: 400");
  expect(episodes).toContain("Collection mode: best_effort_non_blocking (recording errors: 0)");
  expect(episodes).toContain("first");
  const daily = formatSqliteStatsDaily(dailyResponse, true);
  expect(daily).toContain("Daily delivery statistics for daily/first");
  expect(daily).toContain("2026-10-24");
  expect(daily).toMatch(/2026-10-25\s+partial\s+-\s+-/);
  expect(daily).toContain("current_enclosure=yes");
  expect(daily).toContain("lifetime(initial=2");
});

test("retention updates apply idempotently without writing local control journals", async () => {
  const setup = await sqliteServiceFixture();
  fixtures.push(setup);
  administratorKey(setup.root, true);
  const config = await loadWorkspaceConfig(setup.root);
  const serviceHealth = { service_id: config.service_id, worker_version_id: crypto.randomUUID(),
    service_config_sha256: await sqliteServiceConfigHash(config), protocol: "sqlite-sequential-v1",
    domain_changes: "sqlite-domain-change-v1", invocation_id: crypto.randomUUID(), publication_ready: true,
    revision_history: "sqlite-revisions-v1", delivery_statistics: "episode-daily-v1", website: "static-show-v2" };
  const requests: string[] = [];
  const transport = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    const respond = (value: unknown) => Response.json(value, { status: 200, headers: { "Cache-Control": "no-store" } });
    if (request.method === "GET" && path === "/admin/sqlite-service/health") {
      return respond({ ...serviceHealth, scope: "show", show_id: "daily" });
    }
    if (request.method === "POST" && path === "/admin/sqlite-stats/retention") {
      const body = JSON.parse(await request.text()) as { operation_id: string; retention_days: number; show_id: string; service_id: string; service_config_sha256: string };
      return respond({ ...serviceHealth, scope: "show", show_id: "daily",
        retention: { request: body, request_sha256: await sha256Hex(JSON.stringify(body)),
          retention_days: body.retention_days, applied_at_ms: 1_000 } });
    }
    throw new Error(`Unexpected transport call: ${request.method} ${path}`);
  };
  const operationId = crypto.randomUUID();
  const first = await setSqliteStatsRetention(setup.root, config, "daily", 120, operationId, transport);
  expect(first).toMatchObject({ retention: { retention_days: 120 } });
  expect(requests).toEqual(["GET /admin/sqlite-service/health", "POST /admin/sqlite-stats/retention"]);
  const second = await setSqliteStatsRetention(setup.root, config, "daily", 130, operationId, transport);
  expect(second).toMatchObject({ retention: { retention_days: 130 } });
});
