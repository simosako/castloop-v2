import { afterEach, expect, test } from "bun:test";
import { accessStatsSelection, readAccessStats, refreshAccessStats, exportAccessLogs, formatAccessStats } from "./access-stats";
import { SqliteServiceClient } from "./sqlite-service-client";
import { administratorKey } from "./administrator-key";
import { readSqliteManagementGet } from "./sqlite-management-http";
import { sqliteAccessStatsDailyResponseSchema } from "../../shared/src/sqlite-access-stats";
import { runSqliteCommand } from "./sqlite-commands";
import { accessStatsFixture } from "./test-support/access-stats";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

type Fixture = Awaited<ReturnType<typeof accessStatsFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function fixture(ageDays = 3) { const f = await accessStatsFixture(ageDays); fixtures.push(f); return f; }
const selection = (f: Fixture, from = f.date(2), to = f.date(0)) => ({ sourceId: f.source.source_id, from, to });
function refresh(f: Fixture, from?: string, to?: string) { return refreshAccessStats(f.root, f.config, "daily", selection(f, from, to), f.options); }
function daily(f: Fixture, path = f.audio.resource_path, from = f.date(2), to = f.date(0)) {
  return f.client.accessDaily("daily", { source_id: f.source.source_id, resource_path: path, from_date_utc: from, to_date_utc: to });
}
const posts = (f: Fixture) => f.requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/admin/sqlite-access-stats/daily");

test("refresh connects R2, deduplication, per-material zero observations and idempotent Show storage without changing Worker statistics", async () => {
  const f = await fixture();
  f.putLogs("a.gz", [f.record("a"), f.record("a"), f.record("range", f.date(2), { EdgeResponseStatus: 206, EdgeResponseBodyBytes: 300 }),
    f.record("head", f.date(2), { ClientRequestMethod: "HEAD", EdgeResponseStatus: 304 }),
    f.record("304", f.date(2), { EdgeResponseStatus: 304 }), f.record("cover", f.date(2), { ClientRequestPath: f.cover.resource_path }),
    f.record("internal", f.date(2), { WorkerSubrequest: true }), f.record("foreign", f.date(2), { ClientRequestPath: "/podcasts/weekly/cover.jpg" })]);
  const workerBefore = await f.client.statsEpisodes("daily");
  expect(await refresh(f)).toMatchObject({ result: "access-stats-refreshed", changed: 6, unchanged: 0, input_file_count: 1 });
  const result = await daily(f);
  expect(result.period).toMatchObject({ get_200_requests: 1, get_206_requests: 1, head_requests: 1, not_modified_requests: 1, response_bytes: 120300 });
  expect(result.days[0]).toMatchObject({ coverage: "observed", record: { version: 1 } });
  expect(result.days[1]).toMatchObject({ coverage: "observed", record: { daily: { counters: { get_200_requests: 0 } }, input_min_at_ms: null } });
  expect(result.days[2]!.coverage).toBe("partial");
  expect(await refresh(f)).toMatchObject({ changed: 0, unchanged: 6 });
  expect((await daily(f)).days[0]!.record!.version).toBe(1);
  expect(await f.client.statsEpisodes("daily")).toEqual(workerBefore);
  expect(f.requests.filter((request) => request.method !== "GET" && new URL(request.url).hostname === "api.cloudflare.com")).toEqual([]);
});

test("late logs replace daily values, report out-of-window dates and keep hashes stable across window selection and index rebuilds", async () => {
  const f = await fixture(); f.putLogs("a.gz", [f.record("original")]);
  await refresh(f); const original = (await daily(f)).days[0]!.record!;
  await refresh(f, f.date(2), f.date(2)); expect((await daily(f)).days[0]!.record!.input_sha256).toBe(original.input_sha256);
  unlinkSync(join(f.root, ".castloop", "access-log-files.sqlite"));
  expect(await refresh(f)).toMatchObject({ changed: 0 });
  f.putLogs("late.gz", [f.record("original"), f.record("late"), f.record("outside", f.date(3))]);
  expect(await refresh(f)).toMatchObject({ new_outside_dates_utc: [f.date(3)] });
  const updated = (await daily(f)).days[0]!.record!;
  expect(updated.daily.counters.get_200_requests).toBe(2); expect(updated.version).toBe(original.version + 1);
});

test("all logs must parse before the first mutation, and lost row acknowledgements are not automatically replayed", async () => {
  const f = await fixture(); f.putLogs("a.gz", [f.record("a")]); f.putFile("z.gz", `${JSON.stringify(f.record("z"))}\nnot-json private@example.com`);
  await expect(refresh(f)).rejects.toThrow("Invalid JSON"); expect(posts(f)).toHaveLength(0);
  f.objects.delete([...f.objects.keys()].find((key) => key.endsWith("z.gz"))!);
  let sent = 0;
  const transport: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    if (init?.method === "POST" && String(input).endsWith("/sqlite-access-stats/daily") && ++sent === 1) throw new Error("Lost acknowledgement");
    return response;
  };
  await expect(refreshAccessStats(f.root, f.config, "daily", selection(f), { ...f.options, transport })).rejects.toThrow("not verified");
  expect(sent).toBe(1); expect(posts(f)).toHaveLength(1);
  expect(await refresh(f)).toMatchObject({ changed: 5, unchanged: 1 });
});

test("daily expected versions are read before the R2 snapshot and conflicts preserve the newer result", async () => {
  const f = await fixture(); f.putLogs("a.gz", [f.record("a")]); await refresh(f);
  const prior = (await daily(f)).days[0]!.record!;
  f.putLogs("b.gz", [f.record("b")]);
  let injected = false;
  const transport: typeof f.transport = async (input, init) => {
    if (!injected && String(input).includes("/objects?")) {
      injected = true;
      const source = (await f.client.accessSources("daily")).sources[0]!;
      await f.client.replaceAccessDaily({ service_id: f.config.service_id, service_config_sha256: (await f.client.health("daily")).service_config_sha256,
        show_id: "daily", source: source.source, expected_source_version: source.version,
        daily: { ...prior.daily, counters: { ...prior.daily.counters, get_200_requests: 7, cache_status_requests: { hit: 7 } } },
        expected_version: prior.version, input_sha256: "f".repeat(64), read_at_ms: Date.now(),
        input_min_at_ms: prior.input_min_at_ms, input_max_at_ms: prior.input_max_at_ms });
    }
    return f.transport(input, init);
  };
  await expect(refreshAccessStats(f.root, f.config, "daily", selection(f), { ...f.options, transport })).rejects.toThrow("not verified");
  expect((await daily(f)).days[0]!.record!.daily.counters.get_200_requests).toBe(7);
});

test("refresh preserves previously observed delivery interruptions when the job reports a newer error", async () => {
  const f = await fixture();
  const at = Date.parse(`${f.date(2)}T08:00:00Z`);
  f.jobs[0]!.last_error = new Date(at).toISOString(); f.jobs[0]!.last_complete = new Date(at + 1000).toISOString();
  await refresh(f);
  f.jobs[0]!.last_error = new Date(at + 2000).toISOString(); f.jobs[0]!.last_complete = new Date(at + 3000).toISOString();
  await refresh(f);
  const source = (await f.client.accessSources("daily")).sources[0]!.source;
  expect(source.interruptions).toEqual(expect.arrayContaining([
    { started_at_ms: at, ended_at_ms: at + 1000, reason_code: "delivery_error" },
    { started_at_ms: at + 2000, ended_at_ms: at + 3000, reason_code: "delivery_error" },
  ]));
  expect((await daily(f)).days[0]!.coverage).toBe("partial");
});

test("access lists sources/resources and formats daily zero, missing and pruned values with definitions and reflection times", async () => {
  const f = await fixture();
  expect(await readAccessStats(f.root, f.config, "daily", {}, f.transport)).toMatchObject({ view: "sources", sources: [] });
  await refresh(f, f.date(1), f.date(0));
  const sourceList = await readAccessStats(f.root, f.config, "daily", {}, f.transport);
  expect(formatAccessStats(sourceList)).toContain(f.source.source_id);
  const materials = await readAccessStats(f.root, f.config, "daily", { sourceId: f.source.source_id }, f.transport);
  expect(materials).toMatchObject({ view: "resources", resources: expect.arrayContaining([f.audio, f.cover]) });
  const result = await readAccessStats(f.root, f.config, "daily", { ...selection(f), resourcePath: f.audio.resource_path }, f.transport);
  const text = formatAccessStats(result);
  expect(text).toContain("best_effort; bots included"); expect(text).toContain("Unsupported metrics:");
  expect(text).toContain(`${f.date(2)}\tunmeasured\t-`); expect(text).toContain(`${f.date(1)}\tobserved\t0`);
  expect(text).toContain("READ_AT\tAPPLIED_AT");
  const pruned = await readAccessStats(f.root, f.config, "daily", { sourceId: f.source.source_id, resourcePath: f.audio.resource_path, from: f.date(500), to: f.date(500) }, f.transport);
  expect(formatAccessStats(pruned)).toContain(`${f.date(500)}\tpruned\t-`);
});

test("twelve months of retained daily zero observations are paginated and periods outside collection stay unmeasured", async () => {
  const f = await fixture(399);
  expect(await refresh(f, f.date(365), f.date(0))).toMatchObject({ changed: 732 });
  let cursor: string | undefined, count = 0;
  do {
    const page = await f.client.accessDaily("daily", { source_id: f.source.source_id, resource_path: f.audio.resource_path,
      from_date_utc: f.date(365), to_date_utc: f.date(0), ...(cursor ? { cursor } : {}) });
    count += page.days.length; expect(page.period?.get_200_requests).toBe(0); cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(count).toBe(366);
  await expect(refresh(f, f.date(400), f.date(400))).rejects.toThrow("400-day");
});

test("logs exports only approved Show records to private NDJSON, preserves duplicates, and removes its own incomplete output", async () => {
  const f = await fixture();
  f.putLogs("a.gz", [f.record("a"), f.record("a"), f.record("foreign", f.date(2), { ClientRequestPath: "/podcasts/weekly/cover.jpg" })]);
  const output = join(f.root, "access.ndjson"), options = { ...selection(f), output };
  expect(await exportAccessLogs(f.root, f.config, "daily", options, f.options)).toMatchObject({ record_count: 2, includes_delivery_duplicates: true });
  expect(statSync(output).mode & 0o777).toBe(0o600);
  const records = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.map((record) => record.event_id)).toEqual(["a", "a"]); expect(records.every((record) => record.show_id === "daily")).toBe(true);
  expect(posts(f)).toHaveLength(0);
  await expect(exportAccessLogs(f.root, f.config, "daily", options, f.options)).rejects.toThrow();
  expect(readFileSync(output, "utf8").trim().split("\n")).toHaveLength(2);
  const partial = join(f.root, "partial.ndjson"); f.putFile("z.gz", "private@example.com not-json");
  await expect(exportAccessLogs(f.root, f.config, "daily", { ...options, output: partial }, f.options)).rejects.toThrow("Invalid JSON");
  expect(existsSync(partial)).toBe(false); expect(existsSync(output)).toBe(true);
});

test("access clients reject mismatched response identities, nested targets, input hashes and invalid allowlist queries", async () => {
  const f = await fixture(); await refresh(f);
  for (const kind of ["show", "nested", "hash"] as const) {
    const transport: typeof f.transport = async (input, init) => {
      const response = await f.transport(input, init);
      if (!String(input).includes("/sqlite-access-stats/daily")) return response;
      const data = await response.json() as Record<string, unknown>;
      if (kind === "show") data.show_id = "weekly";
      if (kind === "nested" && data.days) {
        const parsed = sqliteAccessStatsDailyResponseSchema.parse(data);
        parsed.days[0]!.record!.daily = { ...parsed.days[0]!.record!.daily, ...f.cover };
        return Response.json(parsed, { headers: { "Cache-Control": "no-store" } });
      }
      if (kind === "hash" && data.record) (data.record as { input_sha256: string }).input_sha256 = "e".repeat(64);
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    };
    const client = new SqliteServiceClient(f.config, administratorKey(f.root), transport);
    if (kind === "hash") await expect(refreshAccessStats(f.root, f.config, "daily", selection(f), f.options, transport)).rejects.toThrow("exact request");
    else await expect(client.accessDaily("daily", { source_id: f.source.source_id, resource_path: f.audio.resource_path,
      from_date_utc: f.date(2), to_date_utc: f.date(0) })).rejects.toThrow("target");
  }
  let reads = 0;
  for (const path of ["/admin/sqlite-access-stats/sources?unknown=1", "/admin/sqlite-access-stats/daily?from=a&from=b", "/admin/sqlite-access-stats/raw"]) {
    await expect(readSqliteManagementGet(new URL(path, f.config.workers_dev_base_url), {}, { transport: async () => { reads++; return Response.json({}); } })).rejects.toThrow("Invalid bounded");
  }
  expect(reads).toBe(0);
});

test("new stats actions route with exact options, preserve legacy Show names, and reject invalid selections before IO", async () => {
  const f = await fixture();
  for (const options of [{}, { sourceId: f.source.source_id, output: "unexpected" }, { sourceId: f.source.source_id, from: "2026-02-30" },
    { sourceId: f.source.source_id, from: f.date(366), to: f.date(0) }]) expect(() => accessStatsSelection("refresh", options)).toThrow();
  expect(() => accessStatsSelection("access", { sourceId: f.source.source_id, from: f.date(2) })).toThrow();
  const result = await runSqliteCommand(f.root, f.config, "stats", ["refresh", "daily"], { cloudflare: f.options, accessStatsOptions: selection(f) });
  expect(result).toMatchObject({ changed: 6 });
  expect(await runSqliteCommand(f.root, f.config, "stats", ["access", "daily"], { transport: f.transport })).toMatchObject({ view: "sources" });
  const before = readFileSync(join(f.root, "castloop.toml"), "utf8");
  await expect(refreshAccessStats(f.root, { ...f.config, service_id: "other" }, "daily", selection(f), f.options)).rejects.toThrow("No saved Logpush source");
  expect(readFileSync(join(f.root, "castloop.toml"), "utf8")).toBe(before);
});
