import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft, stringifyToml } from "@castloop/shared";
import { sqliteScheduleStatusSchema } from "../../shared/src/sqlite-schedule";
import { SQLITE_DOMAIN_PROTOCOL, sqliteDomainRequestHash } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { runSqliteCommand } from "./sqlite-commands";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { initializeSqliteService } from "./sqlite-initialization";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { RSS_IMPORT_AUDIO } from "./test-support/rss-import";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function fixture() {
  const f = await sqliteServiceFixture(); fixtures.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "source", f.options, { attempts: 2, delay: async () => {} });
  const run = (name: string, args: string[], extra: SqliteCommandOptions = {}) => runSqliteCommand(f.root, f.config, name, args,
    { transport: f.transport, cloudflare: f.options, ...extra });
  await run("create-show", ["daily", "https://example.com"]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255)); await run("publish-show", ["daily"]);
  await run("create-episode", ["daily", "first"]); writeFileSync(join(f.root, "daily", "audio.mp3"), RSS_IMPORT_AUDIO);
  const at = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const scheduleOptions = { at }, args = ["daily", "first", "audio.mp3"];
  const preview = await run("preview-episode-schedule", args, { scheduleOptions }) as { approval_sha256: string };
  return Object.assign(f, { run, args, scheduleOptions, preview });
}

test("schedule creation places local media only after exact approval and freezes inline content without a publication journal", async () => {
  const f = await fixture(); f.calls.length = 0;
  await expect(f.run("schedule-episode", f.args, { scheduleOptions: f.scheduleOptions, expectedPreview: "f".repeat(64) })).rejects.toThrow("hash differs");
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  const status = sqliteScheduleStatusSchema.parse(await f.run("schedule-episode", f.args,
    { scheduleOptions: f.scheduleOptions, expectedPreview: f.preview.approval_sha256 }));
  expect(status.schedule.state).toBe("scheduled"); expect(status.publication.kind).toBe("episode");
  expect(f.content.episodes("daily")).toHaveLength(0);
  expect(readdirSync(join(f.root, ".castloop"))).not.toContain("sqlite-drafts");
  expect(await f.run("schedule-status", ["daily", status.schedule.schedule_id])).toMatchObject({ schedule: status.schedule, publication: status.publication });
});

test("reapproval keeps server-frozen metadata and media rather than edited local inputs", async () => {
  const f = await fixture();
  const status = sqliteScheduleStatusSchema.parse(await f.run("schedule-episode", f.args,
    { scheduleOptions: f.scheduleOptions, expectedPreview: f.preview.approval_sha256 }));

  // A completed domain change suspends future schedules and requires explicit reapproval afterwards.
  const target = { ...f.config, public_base_url: "https://podcasts.example.com" };
  const request = { schema_version: 1 as const, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: crypto.randomUUID(), action: "add" as const,
    hostname: "podcasts.example.com", zone_id: "c".repeat(32), zone_name: "example.com", namespace_id: "b".repeat(32),
    previous_config: f.config, previous_config_sha256: await sqliteServiceConfigHash(f.config), target_config: target,
    target_config_sha256: await sqliteServiceConfigHash(target), worker_source_sha256: "d".repeat(64), worker_metadata_sha256: "e".repeat(64) };
  const connection = { id: "f".repeat(32), cert_id: crypto.randomUUID(), hostname: request.hostname, zone_id: request.zone_id,
    zone_name: request.zone_name, service: f.config.worker_name, environment: "production" as const, enabled: true as const, previews_enabled: false as const };
  await f.control.prepareDomain(request);
  await f.bucket.put("system/service.toml", stringifyToml(target));
  const deployed = await f.deployConfiguration(target);
  const commit = { operation_id: request.operation_id, request_sha256: await sqliteDomainRequestHash(request),
    worker_version_id: deployed.worker_version_id, deployment_id: crypto.randomUUID(), script_etag: "acknowledged", connection };
  await f.control.commitDomain(commit);
  await f.control.finalizeDomain({ operation_id: request.operation_id, request_sha256: commit.request_sha256, connection, detached: false });
  const run = (name: string, args: string[], extra: SqliteCommandOptions = {}) => runSqliteCommand(f.root, target, name, args,
    { transport: f.transport, cloudflare: f.options, ...extra });
  const current = sqliteScheduleStatusSchema.parse(await run("schedule-status", ["daily", status.schedule.schedule_id]));
  expect(current.schedule.state).toBe("needs_approval");
  const file = join(f.root, "daily", "episode-first.toml");
  writeFileSync(file, stringifyToml({ ...parseEpisodeDraft(readFileSync(file, "utf8")), title: "Unapproved edit" }));
  const args = ["daily", status.schedule.schedule_id], scheduleOptions = { ...f.scheduleOptions, expectVersion: String(current.schedule.version) };
  const preview = await run("preview-schedule-reapprove", args, { scheduleOptions }) as { approval_sha256: string };
  f.calls.length = 0;
  const reapproved = sqliteScheduleStatusSchema.parse(await run("schedule-reapprove", args, { scheduleOptions, expectedPreview: preview.approval_sha256 }));
  expect(reapproved.publication.metadata).toEqual(status.publication.metadata);
  expect(reapproved.schedule.state).toBe("scheduled"); expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("metadata-only schedules reuse the concrete published audio without a new MP3", async () => {
  const f = await fixture(); await f.run("publish-episode", f.args);
  const file = join(f.root, "daily", "episode-first.toml");
  writeFileSync(file, stringifyToml({ ...parseEpisodeDraft(readFileSync(file, "utf8")), title: "Scheduled metadata" }));
  const args = ["daily", "first"], preview = await f.run("preview-episode-schedule", args, { scheduleOptions: f.scheduleOptions }) as { approval_sha256: string };
  f.calls.length = 0;
  const status = sqliteScheduleStatusSchema.parse(await f.run("schedule-episode", args, { scheduleOptions: f.scheduleOptions, expectedPreview: preview.approval_sha256 }));
  expect(status.publication.kind === "episode" && status.publication.audio.sha256).toBe(f.content.episodes("daily")[0]!.sha256);
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);

  const cancelPreview = await f.run("preview-schedule-cancel", ["daily", status.schedule.schedule_id]) as { approval_sha256: string };
  await f.run("schedule-cancel", ["daily", status.schedule.schedule_id],
    { scheduleOptions: { expectVersion: String(status.schedule.version) }, expectedPreview: cancelPreview.approval_sha256 });
  f.calls.length = 0;
  const same = await f.run("preview-episode-schedule", f.args, { scheduleOptions: f.scheduleOptions }) as { approval_sha256: string };
  const withSameMp3 = sqliteScheduleStatusSchema.parse(await f.run("schedule-episode", f.args,
    { scheduleOptions: f.scheduleOptions, expectedPreview: same.approval_sha256 }));
  expect(withSameMp3.publication.kind === "episode" && withSameMp3.publication.audio.sha256).toBe(f.content.episodes("daily")[0]!.sha256);
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
});
