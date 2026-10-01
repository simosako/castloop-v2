import * as TOML from "@iarna/toml";
import { z } from "zod";
import { controlActionSchema, lifecycleStateSchema } from "./lifecycle";

export const lifecyclePhaseSchema = z.enum([
  "admitted", "validating", "visibility", "feed", "purge", "deleting", "verifying", "finalizing", "finished",
]);

export const lifecycleFailureMessages = {
  validation_failed: "Stored inputs could not be validated.",
  state_update_failed: "Lifecycle state update failed.",
  feed_update_failed: "Feed preparation or update failed.",
  cache_purge_failed: "Cache purge failed.",
  payload_deletion_failed: "Payload deletion failed.",
  deletion_verification_failed: "Deletion verification failed.",
  completion_failed: "Operation finalization failed.",
} as const;

export type LifecycleFailure = {
  reason_code: keyof typeof lifecycleFailureMessages;
  reason: typeof lifecycleFailureMessages[keyof typeof lifecycleFailureMessages];
};

export function lifecycleFailureForPhase(phase: z.infer<typeof lifecyclePhaseSchema>): LifecycleFailure {
  const codes: Record<z.infer<typeof lifecyclePhaseSchema>, LifecycleFailure["reason_code"]> = {
    admitted: "validation_failed", validating: "validation_failed", visibility: "state_update_failed",
    feed: "feed_update_failed", purge: "cache_purge_failed", deleting: "payload_deletion_failed",
    verifying: "deletion_verification_failed", finalizing: "completion_failed", finished: "completion_failed",
  };
  const code = codes[phase];
  return { reason_code: code, reason: lifecycleFailureMessages[code] };
}

const identity = {
  job_id: z.uuid(),
  show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.enum(["show", "episode"]),
  episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  action: controlActionSchema,
  show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

export const lifecycleJobStatusSchema = z.object({
  schema_version: z.literal(2),
  ...identity,
  state: z.enum(["reserved", "processing", "retrying", "failed", "published", "completed", "abandoned"]),
  phase: lifecyclePhaseSchema,
  result_lifecycle: lifecycleStateSchema.optional(),
  reason_code: z.enum(["validation_failed", "state_update_failed", "feed_update_failed", "cache_purge_failed",
    "payload_deletion_failed", "deletion_verification_failed", "completion_failed"]).optional(),
  reason: z.enum(lifecycleFailureMessages).optional(),
}).strict().superRefine((value, context) => {
  if ((value.reason_code !== undefined) !== (value.reason !== undefined) ||
    (value.reason_code && value.reason !== lifecycleFailureMessages[value.reason_code])) {
    context.addIssue({ code: "custom", message: "Failure reason must match its allowlisted diagnostic code" });
  }
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode jobs require an Episode ID" });
  }
  const terminal = value.state === "published" || value.state === "completed" || value.state === "abandoned";
  if (terminal !== (value.phase === "finished")) {
    context.addIssue({ code: "custom", message: "Only terminal jobs have a finished phase" });
  }
  if ((value.state === "published" && value.action !== "publish") ||
    (value.state === "completed" && value.action === "publish")) {
    context.addIssue({ code: "custom", message: "Publication and lifecycle terminal states are distinct" });
  }
  if (value.state === "published" || value.state === "completed") {
    const expected = { publish: "active", stage: undefined, unpublish: "unpublished", restore: "active", delete: "deleted" };
    if (value.result_lifecycle !== expected[value.action]) {
      context.addIssue({ code: "custom", message: "Job result does not match its action" });
    }
  } else if (value.result_lifecycle !== undefined) {
    context.addIssue({ code: "custom", message: "An unfinished or abandoned job cannot claim a lifecycle result" });
  }
});

export const lifecycleProgressSchema = z.object({
  schema_version: z.literal(1),
  ...identity,
  phase: lifecyclePhaseSchema,
  deleted_objects: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  purge_confirmed: z.boolean(),
  updated_at: z.iso.datetime({ offset: true, precision: 0 }),
  deletion_scope_index: z.number().int().nonnegative().max(5).optional(),
  deletion_cursor: z.string().min(1).max(4096).optional(),
  final_purge_confirmed: z.boolean().optional(),
  tombstone_cursor: z.string().min(1).max(4096).optional(),
  tombstoned_episodes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  tombstones_complete: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode progress requires an Episode ID" });
  }
  if (value.action !== "delete" && value.deleted_objects !== 0) {
    context.addIssue({ code: "custom", message: "Only deletion progress can count removed objects" });
  }
  if (value.action !== "delete" && (value.deletion_scope_index !== undefined || value.deletion_cursor !== undefined)) {
    context.addIssue({ code: "custom", message: "Only deletion progress can contain a deletion position" });
  }
  if (value.deletion_cursor !== undefined &&
    (value.deletion_scope_index === undefined || (value.phase !== "deleting" && value.phase !== "verifying"))) {
    context.addIssue({ code: "custom", message: "Deletion cursors require an active deletion or verification scope" });
  }
  if (value.final_purge_confirmed !== undefined && (value.action !== "delete" || !value.purge_confirmed ||
    (value.phase !== "finalizing" && value.phase !== "finished"))) {
    context.addIssue({ code: "custom", message: "Final purge evidence requires verified deletion finalization progress" });
  }
  const childProgress = value.tombstone_cursor !== undefined || value.tombstoned_episodes !== undefined || value.tombstones_complete !== undefined;
  if (childProgress && (value.action !== "delete" || value.kind !== "show" ||
    (value.phase !== "finalizing" && value.phase !== "finished") || !value.final_purge_confirmed)) {
    context.addIssue({ code: "custom", message: "Child tombstones require final-purged Show deletion progress" });
  }
  if (value.tombstone_cursor !== undefined && (value.phase !== "finalizing" || value.tombstones_complete)) {
    context.addIssue({ code: "custom", message: "Completed child tombstones cannot have a continuation cursor" });
  }
  if (value.action === "delete" && value.phase === "finished" &&
    (!value.purge_confirmed || !value.final_purge_confirmed ||
      value.deletion_scope_index !== (value.kind === "show" ? 5 : 3) || value.deletion_cursor !== undefined ||
      (value.kind === "show" && !value.tombstones_complete))) {
    context.addIssue({ code: "custom", message: "Finished deletion requires payload verification, final purge and applicable tombstones" });
  }
});

export type LifecycleJobStatus = z.infer<typeof lifecycleJobStatusSchema>;
export type LifecycleProgress = z.infer<typeof lifecycleProgressSchema>;

export function parseLifecycleProgress(source: string): LifecycleProgress {
  return lifecycleProgressSchema.parse(TOML.parse(source));
}

export function stringifyLifecycleProgress(value: LifecycleProgress): string {
  return TOML.stringify(value as TOML.JsonMap);
}
