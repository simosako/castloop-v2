import { z } from "zod";
import { adminTimezoneSchema } from "./admin-config";
import { sha256Hex } from "./sha256";
import { sqlitePublicationTargetSchema, sqlitePublicationRuntimeSchema, sqliteServiceIdentitySchema } from "./sqlite-publication";
import { sqliteDirectPublishRequestSchema } from "./sqlite-direct-publication";

export const sqliteScheduleProtocol = "sqlite-schedule-v1" as const;
export const SQLITE_SCHEDULE_PAGE_SIZE = 20;
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.refine((value) => value > 0, "Expected a positive integer");
const showId = sqlitePublicationTargetSchema.shape.show_id;
const episodeId = sqlitePublicationTargetSchema.shape.episode_id.unwrap();
const isoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "Expected a UTC ISO date/time through seconds");
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Expected a local ISO date/time through seconds");
const offset = z.string().regex(/^[+-]\d{2}:\d{2}$/);

export const sqliteScheduleTimeSchema = z.object({
  input: z.string().min(1).max(64),
  scheduled_at: isoInstant,
  scheduled_at_ms: counter,
  input_offset: offset.nullable(),
  resolution_source: z.enum(["offset", "cli", "config", "server"]),
  timezone: adminTimezoneSchema,
  timezone_source: z.enum(["cli", "config", "server"]),
  local_datetime: localDateTime,
  offset,
}).strict().superRefine((value, context) => {
  if (!Number.isSafeInteger(Date.parse(value.scheduled_at)) || Date.parse(value.scheduled_at) !== value.scheduled_at_ms) {
    context.addIssue({ code: "custom", message: "Scheduled UTC time and milliseconds differ" });
  }
});

export const sqliteScheduleReasonSchema = z.enum(["domain_change",
  "base_conflict", "target_unavailable",
  "cancelled_by_administrator"]);
export type SqliteScheduleReason = z.infer<typeof sqliteScheduleReasonSchema>;

const runtime = sqliteServiceIdentitySchema.shape;
const showCreateFields = {
  schema_version: z.literal(1),
  protocol: z.literal(sqliteScheduleProtocol),
  service_id: runtime.service_id,
  service_config_sha256: runtime.service_config_sha256,
  show_id: showId,
};

export const sqliteScheduleCreateSchema = z.object({
  ...showCreateFields,
  schedule_id: uuid,
  expected_version: z.literal(0),
  preview_sha256: hash,
  scheduled_at: sqliteScheduleTimeSchema,
  publication: sqliteDirectPublishRequestSchema,
}).strict().superRefine((value, context) => {
  const publication = value.publication;
  if (publication.action !== "publish" || publication.service_id !== value.service_id ||
    publication.service_config_sha256 !== value.service_config_sha256 ||
    publication.show_id !== value.show_id ||
    (publication.kind === "show" ? publication.episode_id !== undefined : publication.episode_id === undefined)) {
    context.addIssue({ code: "custom", message: "Schedule creation differs from its frozen publication request" });
  }
});

export const sqliteScheduleRescheduleSchema = z.object({
  ...showCreateFields,
  schedule_id: uuid,
  expected_version: positiveCounter,
  preview_sha256: hash,
  scheduled_at: sqliteScheduleTimeSchema,
}).strict();

export const sqliteScheduleCancelSchema = z.object({
  ...showCreateFields,
  schedule_id: uuid,
  expected_version: positiveCounter,
  preview_sha256: hash,
}).strict();

export const sqliteScheduleReapproveSchema = z.object({
  ...showCreateFields,
  schedule_id: uuid,
  expected_version: positiveCounter,
  preview_sha256: hash,
  scheduled_at: sqliteScheduleTimeSchema,
  publication: sqliteDirectPublishRequestSchema,
}).strict().superRefine((value, context) => {
  const publication = value.publication;
  if (publication.action !== "publish" || publication.service_id !== value.service_id ||
    publication.service_config_sha256 !== value.service_config_sha256 ||
    publication.show_id !== value.show_id ||
    (publication.kind === "show" ? publication.episode_id !== undefined : publication.episode_id === undefined)) {
    context.addIssue({ code: "custom", message: "Schedule reapproval differs from its frozen publication request" });
  }
});

export const sqliteScheduleStateSchema = z.enum(["scheduled", "needs_approval", "dispatched", "cancelled", "failed"]);
export const sqliteScheduleRecordSchema = z.object({
  protocol: z.literal(sqliteScheduleProtocol),
  service_id: runtime.service_id,
  show_id: showId,
  schedule_id: uuid,
  version: positiveCounter,
  state: sqliteScheduleStateSchema,
  kind: sqlitePublicationTargetSchema.shape.kind,
  episode_id: episodeId.nullable(),
  scheduled_at: sqliteScheduleTimeSchema,
  revision_id: uuid.nullable(),
  request_sha256: hash,
  preview_sha256: hash,
  reason_code: sqliteScheduleReasonSchema.nullable(),
  created_at_ms: counter,
  updated_at_ms: counter,
  dispatched_at_ms: counter.nullable(),
  cancelled_at_ms: counter.nullable(),
}).strict().superRefine((value, context) => {
  const reasonRequired = ["needs_approval", "failed"].includes(value.state);
  if ((value.kind === "episode") !== (value.episode_id !== null) ||
    (value.state === "dispatched") !== (value.revision_id !== null) ||
    value.state !== "cancelled" && reasonRequired !== (value.reason_code !== null) ||
    value.state === "cancelled" && value.reason_code !== null && value.reason_code !== "cancelled_by_administrator") {
    context.addIssue({ code: "custom", message: "Schedule state, target and reason differ" });
  }
  if (value.state === "cancelled" && value.cancelled_at_ms === null ||
    value.state !== "cancelled" && value.cancelled_at_ms !== null ||
    value.state === "dispatched" && value.dispatched_at_ms === null ||
    value.state !== "dispatched" && value.dispatched_at_ms !== null) {
    context.addIssue({ code: "custom", message: "Schedule timestamps differ from its state" });
  }
});

export const sqliteScheduleStatusSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqliteScheduleProtocol),
  show_id: showId,
  schedule: sqliteScheduleRecordSchema,
  publication: sqliteDirectPublishRequestSchema,
}).strict().superRefine((value, context) => {
  if (value.service_id !== value.schedule.service_id || value.show_id !== value.schedule.show_id) {
    context.addIssue({ code: "custom", message: "Schedule response target differs" });
  }
});

export const sqliteScheduleListSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqliteScheduleProtocol),
  show_id: showId,
  schedules: z.array(sqliteScheduleRecordSchema).max(SQLITE_SCHEDULE_PAGE_SIZE),
  next_cursor: uuid.nullable(),
}).strict().superRefine((value, context) => {
  if (value.schedules.some((schedule) => schedule.service_id !== value.service_id || schedule.show_id !== value.show_id) ||
    value.next_cursor !== null && (value.schedules.length !== SQLITE_SCHEDULE_PAGE_SIZE ||
      value.next_cursor !== value.schedules.at(-1)?.schedule_id)) {
    context.addIssue({ code: "custom", message: "Schedule list page differs from its response identity" });
  }
});

export const sqliteSchedulePlanSchema = z.object({
  schema_version: z.literal(1),
  action: z.enum(["schedule", "reschedule", "cancel", "reapprove"]),
  show_id: showId,
  kind: sqlitePublicationTargetSchema.shape.kind.optional(),
  episode_id: episodeId.optional(),
  preview_fingerprint: hash.optional(),
  schedule_id: uuid.optional(),
  expected_version: positiveCounter.optional(),
  scheduled_at: sqliteScheduleTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  const valid = value.action === "schedule" ?
    value.kind !== undefined && value.preview_fingerprint !== undefined &&
      value.scheduled_at !== undefined && value.schedule_id === undefined && value.expected_version === undefined &&
      (value.kind === "episode") === (value.episode_id !== undefined) :
    value.action === "reapprove" ?
      value.schedule_id !== undefined && value.expected_version !== undefined && value.preview_fingerprint !== undefined &&
        value.scheduled_at !== undefined && value.kind === undefined &&
        value.episode_id === undefined :
      value.schedule_id !== undefined && value.expected_version !== undefined && value.kind === undefined &&
        value.preview_fingerprint === undefined && value.episode_id === undefined &&
        (value.action === "cancel" ? value.scheduled_at === undefined : value.scheduled_at !== undefined);
  if (!valid) context.addIssue({ code: "custom", message: "Schedule plan fields differ from its action" });
});

export type SqliteScheduleTime = z.infer<typeof sqliteScheduleTimeSchema>;
export type SqliteScheduleCreate = z.infer<typeof sqliteScheduleCreateSchema>;
export type SqliteScheduleReschedule = z.infer<typeof sqliteScheduleRescheduleSchema>;
export type SqliteScheduleCancel = z.infer<typeof sqliteScheduleCancelSchema>;
export type SqliteScheduleReapprove = z.infer<typeof sqliteScheduleReapproveSchema>;
export type SqliteScheduleRecord = z.infer<typeof sqliteScheduleRecordSchema>;
export type SqliteScheduleStatus = z.infer<typeof sqliteScheduleStatusSchema>;
export type SqliteScheduleList = z.infer<typeof sqliteScheduleListSchema>;
export type SqliteSchedulePlan = z.infer<typeof sqliteSchedulePlanSchema>;

export async function sqliteSchedulePlanHash(input: SqliteSchedulePlan): Promise<string> {
  return sha256Hex(JSON.stringify(sqliteSchedulePlanSchema.parse(input)));
}
