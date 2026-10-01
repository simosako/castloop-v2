import * as TOML from "@iarna/toml";
import { z } from "zod";
import { controlActionSchema, lifecycleStateSchema } from "./lifecycle";

export const lifecyclePhaseSchema = z.enum([
  "admitted", "validating", "visibility", "feed", "purge", "deleting", "verifying", "finalizing", "finished",
]);

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
  reason: z.string().min(1).max(4096).optional(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode jobs require an Episode ID" });
  }
  const terminal = value.state === "published" || value.state === "completed" || value.state === "abandoned";
  if (terminal !== (value.phase === "finished")) {
    context.addIssue({ code: "custom", message: "Only terminal jobs have a finished phase" });
  }
  if (value.state === "published" && value.action !== "publish" ||
    value.state === "completed" && value.action === "publish") {
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
}).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode progress requires an Episode ID" });
  }
  if (value.action !== "delete" && value.deleted_objects !== 0) {
    context.addIssue({ code: "custom", message: "Only deletion progress can count removed objects" });
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
