import { expect, test } from "bun:test";
import { resolveScheduleTime, requireFutureScheduleTime } from "./schedule-time";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("schedule conversion uses explicit offset, CLI zone, configuration then server UTC", () => {
  const input = "2026-11-01T09:00:00";
  expect(resolveScheduleTime(input)).toMatchObject({ scheduled_at: `${input}Z`, timezone: "UTC", timezone_source: "server", resolution_source: "server", offset: "+00:00" });
  expect(resolveScheduleTime(input, { configuredTimezone: "Asia/Tokyo" })).toMatchObject({ scheduled_at: "2026-11-01T00:00:00Z", timezone_source: "config", offset: "+09:00" });
  expect(resolveScheduleTime(input, { timezone: "Asia/Tokyo", configuredTimezone: "America/New_York" })).toMatchObject({ scheduled_at: "2026-11-01T00:00:00Z", timezone_source: "cli" });
  expect(resolveScheduleTime(`${input}+09:00`, { configuredTimezone: "America/New_York" })).toMatchObject({
    scheduled_at: "2026-11-01T00:00:00Z", input_offset: "+09:00", resolution_source: "offset", timezone_source: "config",
    local_datetime: "2026-10-31T20:00:00", offset: "-04:00",
  });
  expect(resolveScheduleTime("2026-01-01T00:00", { timezone: "Asia/Kathmandu" }).scheduled_at).toBe("2025-12-31T18:15:00Z");
  expect(resolveScheduleTime("2026-01-01T09:00Z", { timezone: "UTC" }).input_offset).toBe("+00:00");
  expect(() => resolveScheduleTime(`${input}Z`, { timezone: "Asia/Tokyo" })).toThrow("differs");
  expect(() => resolveScheduleTime(`${input}+09:00`, { timezone: "UTC" })).toThrow("differs");
});

test("DST gaps and folds require a real unambiguous instant with a matching explicit offset", () => {
  const timezone = "America/New_York";
  for (const input of ["2026-03-08T02:30:00", "2026-11-01T01:30:00"]) expect(() => resolveScheduleTime(input, { timezone })).toThrow();
  expect(resolveScheduleTime("2026-11-01T01:30:00-04:00", { timezone }).scheduled_at).toBe("2026-11-01T05:30:00Z");
  expect(resolveScheduleTime("2026-11-01T01:30:00-05:00", { timezone }).scheduled_at).toBe("2026-11-01T06:30:00Z");
  for (const input of ["2026-03-08T02:30:00-05:00", "2026-11-01T01:30:00-06:00"]) expect(() => resolveScheduleTime(input, { timezone })).toThrow();
  expect(() => resolveScheduleTime("2026-10-04T02:15:00", { timezone: "Australia/Lord_Howe" })).toThrow();
  expect(resolveScheduleTime("2026-03-08T03:00:00", { timezone }).offset).toBe("-04:00");
});

test("schedule conversion rejects invalid calendars, zones, abbreviations and unsupported syntax", () => {
  for (const input of ["2026-02-29T09:00:00", "2026-04-31T09:00:00Z", "2026-01-01T24:00:00", "2026-01-01T09:60:00",
    "2026-01-01T09:00:60Z", "2026-01-01", "tomorrow", "2026-01-01 09:00:00", "2026-01-01T09:00:00.001Z",
    "2026-01-01T09:00:00+24:00", "2026-01-01T09:00:00-00:00", "0000-01-01T00:00:00Z", "2026-01-01T09:00:00Z[UTC]",
    "2026-01-01T09:00:00Z\n", "2026-01-01T09:00:00\r\n"]) {
    expect(() => resolveScheduleTime(input), input).toThrow();
  }
  for (const timezone of ["JST", "CST", "EST", "+09:00", "Unknown/City", "", " Asia/Tokyo"]) {
    expect(() => resolveScheduleTime("2026-11-01T09:00:00", { timezone }), timezone).toThrow();
  }
  expect(resolveScheduleTime("2028-02-29T09:00:00Z").scheduled_at).toBe("2028-02-29T09:00:00Z");
});

test("frozen instants stay absolute and future validation uses the supplied server clock", () => {
  const frozen = resolveScheduleTime("2026-11-01T09:00:00", { configuredTimezone: "Asia/Tokyo" });
  expect(frozen.scheduled_at_ms).toBe(Date.parse("2026-11-01T00:00:00Z"));
  const before = structuredClone(frozen);
  resolveScheduleTime(frozen.input, { configuredTimezone: "America/New_York" });
  expect(frozen).toEqual(before);
  expect(() => requireFutureScheduleTime(frozen, frozen.scheduled_at_ms - 1)).not.toThrow();
  for (const now of [frozen.scheduled_at_ms, frozen.scheduled_at_ms + 1, NaN, Infinity]) expect(() => requireFutureScheduleTime(frozen, now)).toThrow();
});

test("formal offline time preview is independent of machine TZ, never reserves, and respects workspace preferences", () => {
  const root = mkdtempSync("/tmp/opencode/schedule-time-cli-");
  const run = (args: string[], timezone = "America/Los_Angeles") => {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), ...args, "--json"], {
      cwd: root, env: { PATH: "", TZ: timezone }, timeout: 10000,
    });
    expect(child.stderr.toString()).toBe("");
    return { code: child.exitCode, value: JSON.parse(child.stdout.toString()) };
  };
  try {
    for (const timezone of ["America/Los_Angeles", "Asia/Tokyo"]) {
      const result = run(["preview-schedule-time", "2026-11-01T09:00:00"], timezone);
      expect(result.code).toBe(0);
      expect(result.value.result).toMatchObject({ scheduled_at: "2026-11-01T09:00:00Z", timezone_source: "server", server_time_checked: false, publication_ready: false });
    }
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, "castloop-admin.toml"), 'schema_version = 1\ntimezone = "Asia/Tokyo"\n');
    expect(run(["preview-schedule-time", "2026-11-01T09:00:00"]).value.result).toMatchObject({ scheduled_at: "2026-11-01T00:00:00Z", timezone_source: "config" });
    expect(run(["preview-schedule-time", "2026-11-01T09:00:00", "--timezone", "UTC"]).value.result).toMatchObject({ scheduled_at: "2026-11-01T09:00:00Z", timezone_source: "cli" });
    expect(run(["preview-schedule-time", "2026-11-01T01:30:00", "--timezone", "America/New_York"])).toMatchObject({ code: 1, value: { error: { outcome: "not_started", code: "invalid_schedule_time" } } });
    expect(run(["validate", "admin-config", "castloop-admin.toml"]).code).toBe(0);
    expect(run(["template", "admin-config"]).code).toBe(0);
    expect(run(["schema", "admin-config"]).code).toBe(0);
    writeFileSync(join(root, "castloop-admin.toml"), 'schema_version = 1\ntimezone = "Unknown/City"\n');
    expect(run(["preview-schedule-time", "2026-11-01T09:00:00", "--timezone", "UTC"]).code).toBe(1);
    expect(readdirSync(root)).toEqual(["castloop-admin.toml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
