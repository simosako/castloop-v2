import { sqliteScheduleCancelSchema, sqliteSchedulePlanHash, sqliteScheduleRescheduleSchema, sqliteScheduleCreateSchema, sqliteScheduleReapproveSchema } from "@castloop/shared";
import type { SqliteScheduleStatus, SqliteServiceConfig } from "@castloop/shared";
import { loadAdminConfig } from "./admin-config";
import { resolveScheduleTime } from "./schedule-time";
import { SqliteScheduleClient } from "./sqlite-schedule-client";
import type { R2RestTransport } from "./verified-r2-put";
import { administratorKey } from "./administrator-key";
import { prepareSqlitePublication, placeSqlitePublicationMedia } from "./sqlite-publish";
import type { PreviewTarget } from "./draft-preview";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { SqliteServiceClient } from "./sqlite-service-client";
import { sqliteDirectPublishRequestSchema, sqliteDirectPublicationRequestHash } from "../../shared/src/sqlite-direct-publication";

export async function publicationSchedule(root: string, config: SqliteServiceConfig, target: PreviewTarget, options: SqliteCommandOptions, execute: boolean) {
  const preview = await prepareSqlitePublication(root, config, target, { ...options, expectedPreview: undefined });
  const scheduled_at = await localScheduleTime(root, options.scheduleOptions?.at ?? "", options.scheduleOptions?.timezone);
  if (scheduled_at.scheduled_at_ms <= Date.now()) throw new Error("Schedule must be in the future");
  const approval_sha256 = await sqliteSchedulePlanHash({ schema_version: 1, action: "schedule", show_id: target.show_id,
    kind: target.kind, episode_id: target.episode_id, preview_fingerprint: preview.input_fingerprint, scheduled_at });
  if (!execute) return { publication_preview: preview, scheduled_at, approval_sha256 };
  requirePreview(options.expectedPreview, approval_sha256);
  if (!preview.unchanged) await placeSqlitePublicationMedia(root, config, preview, options);
  const publication = preview.request!;
  return new SqliteScheduleClient(config, administratorKey(root), options.transport).create(sqliteScheduleCreateSchema.parse({
    schema_version: 1, protocol: "sqlite-schedule-v1", service_id: config.service_id, worker_version_id: publication.worker_version_id,
    service_config_sha256: publication.service_config_sha256, show_id: target.show_id, schedule_id: crypto.randomUUID(), expected_version: 0,
    preview_sha256: approval_sha256, scheduled_at, publication }));
}

export async function reapproveSqliteSchedule(root: string, config: SqliteServiceConfig, showId: string, scheduleId: string, options: SqliteCommandOptions, execute: boolean) {
  const key = administratorKey(root), client = new SqliteScheduleClient(config, key, options.transport);
  const current = await client.status(showId, scheduleId), snapshot = await new SqliteServiceClient(config, key, options.transport).content(showId, current.schedule.episode_id ?? undefined);
  const expectedVersion = Number(options.scheduleOptions?.expectVersion);
  if (current.schedule.state !== "needs_approval" || current.schedule.version !== expectedVersion) throw new Error("Schedule reapproval requires the current version of a suspended schedule");
  const publication = sqliteDirectPublishRequestSchema.parse({ ...current.publication, worker_version_id: snapshot.worker_version_id,
    service_config_sha256: snapshot.service_config_sha256, admission_window_id: snapshot.admission_window_id,
    expected_show_state_version: snapshot.expected_show_state_version, ...(current.publication.kind === "episode" ? {
      base_revision_id: snapshot.episode_content?.revision_id, expected_episode_lifecycle_version: snapshot.expected_episode_lifecycle_version } : {}) });
  const scheduled_at = await localScheduleTime(root, options.scheduleOptions?.at ?? "", options.scheduleOptions?.timezone);
  if (scheduled_at.scheduled_at_ms <= Date.now()) throw new Error("Schedule must be in the future");
  const approval_sha256 = await sqliteSchedulePlanHash({ schema_version: 1, action: "reapprove", show_id: showId, schedule_id: scheduleId,
    expected_version: expectedVersion, preview_fingerprint: await sqliteDirectPublicationRequestHash(publication), scheduled_at });
  if (!execute) return { schedule: current.schedule, publication, scheduled_at, approval_sha256 };
  requirePreview(options.expectedPreview, approval_sha256);
  return client.reapprove(sqliteScheduleReapproveSchema.parse({ schema_version: 1, protocol: "sqlite-schedule-v1", service_id: config.service_id,
    worker_version_id: snapshot.worker_version_id, service_config_sha256: snapshot.service_config_sha256, show_id: showId, schedule_id: scheduleId,
    expected_version: expectedVersion, preview_sha256: approval_sha256, scheduled_at, publication }));
}

export function localScheduleTime(root: string, at: string, timezone?: string) {
  if (!at) throw new Error("Scheduled commands require --at DATETIME");
  return loadAdminConfig(root).then((admin) => resolveScheduleTime(at, { timezone, configuredTimezone: admin.timezone }));
}

function requirePreview(expected: string | undefined, actual: string): string {
  if (expected !== actual) throw new Error("Reviewed schedule plan hash differs; preview and approve the exact plan again");
  return expected;
}

export async function previewCancelSqliteSchedule(config: SqliteServiceConfig, key: string, showId: string,
  scheduleId: string, transport?: R2RestTransport) {
  const schedule = await new SqliteScheduleClient(config, key, transport).status(showId, scheduleId);
  if (!["scheduled", "needs_approval"].includes(schedule.schedule.state)) throw new Error("Only an undispatched schedule can be cancelled");
  return { schedule: schedule.schedule, approval_sha256: await sqliteSchedulePlanHash({ schema_version: 1, action: "cancel",
    show_id: showId, schedule_id: scheduleId, expected_version: schedule.schedule.version }) };
}

export async function previewRescheduleSqliteSchedule(root: string, config: SqliteServiceConfig, key: string,
  showId: string, scheduleId: string, at: string, timezone?: string, transport?: R2RestTransport) {
  const schedule = await new SqliteScheduleClient(config, key, transport).status(showId, scheduleId);
  if (schedule.schedule.state !== "scheduled") throw new Error("Only a scheduled, undispatched schedule can be rescheduled");
  const scheduled_at = await localScheduleTime(root, at, timezone);
  if (scheduled_at.scheduled_at_ms <= Date.now()) throw new Error("Schedule must be in the future");
  return { schedule: schedule.schedule, scheduled_at, approval_sha256: await sqliteSchedulePlanHash({ schema_version: 1,
    action: "reschedule", show_id: showId, schedule_id: scheduleId, expected_version: schedule.schedule.version, scheduled_at }) };
}

export async function cancelSqliteSchedule(config: SqliteServiceConfig, key: string, showId: string, scheduleId: string,
  expectedVersion: number, expectedPreview: string | undefined, transport?: R2RestTransport): Promise<SqliteScheduleStatus> {
  const preview = requirePreview(expectedPreview, await sqliteSchedulePlanHash({ schema_version: 1, action: "cancel",
    show_id: showId, schedule_id: scheduleId, expected_version: expectedVersion }));
  const client = new SqliteScheduleClient(config, key, transport);
  const current = await client.status(showId, scheduleId);
  const request = sqliteScheduleCancelSchema.parse({ schema_version: 1, protocol: "sqlite-schedule-v1",
    service_id: current.service_id, worker_version_id: current.worker_version_id,
    service_config_sha256: current.service_config_sha256, show_id: showId, schedule_id: scheduleId,
    expected_version: expectedVersion, preview_sha256: preview });
  return client.cancel(request);
}

export async function rescheduleSqliteSchedule(root: string, config: SqliteServiceConfig, key: string, showId: string,
  scheduleId: string, at: string, timezone: string | undefined, expectedVersion: number, expectedPreview: string | undefined,
  transport?: R2RestTransport): Promise<SqliteScheduleStatus> {
  const time = await localScheduleTime(root, at, timezone);
  const preview = requirePreview(expectedPreview, await sqliteSchedulePlanHash({ schema_version: 1, action: "reschedule",
    show_id: showId, schedule_id: scheduleId, expected_version: expectedVersion, scheduled_at: time }));
  const client = new SqliteScheduleClient(config, key, transport);
  const current = await client.status(showId, scheduleId);
  const request = sqliteScheduleRescheduleSchema.parse({ schema_version: 1, protocol: "sqlite-schedule-v1",
    service_id: current.service_id, worker_version_id: current.worker_version_id,
    service_config_sha256: current.service_config_sha256, show_id: showId, schedule_id: scheduleId,
    expected_version: expectedVersion, preview_sha256: preview, scheduled_at: time });
  return client.reschedule(request);
}
