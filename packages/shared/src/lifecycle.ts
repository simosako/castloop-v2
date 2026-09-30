import * as TOML from "@iarna/toml";
import { z } from "zod";

const slug = (maximum: number) => z.string().max(maximum).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);

export const lifecycleStateSchema = z.enum(["draft", "active", "unpublished", "deleting", "deleted"]);
export const controlActionSchema = z.enum(["publish", "stage", "unpublish", "restore", "delete"]);

const operationOwnerSchema = z.object({
  job_id: z.uuid(),
  kind: z.enum(["show", "episode"]),
  episode_id: slug(80).optional(),
  action: controlActionSchema,
  state: z.enum(["reserved", "processing", "uploading"]),
  request_sha256: checksum,
}).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode operations require an Episode ID" });
  }
  if ((value.action === "stage") !== (value.state === "uploading")) {
    context.addIssue({ code: "custom", message: "Staging operations require an uploading owner" });
  }
});

export const showControlSchema = z.object({
  schema_version: z.literal(2),
  show_id: slug(32),
  lifecycle: lifecycleStateSchema,
  generation,
  feed_generation: generation,
  owner: operationOwnerSchema.optional(),
  last_abandoned_operation: z.object({
    job_id: z.uuid(),
    generation,
    request_sha256: checksum,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.lifecycle === "deleting" || value.lifecycle === "deleted") &&
    value.owner && value.owner.action !== "delete") {
    context.addIssue({ code: "custom", message: "A deleting or deleted Show cannot own another operation" });
  }
  if (value.last_abandoned_operation &&
    (value.last_abandoned_operation.generation >= value.generation ||
      value.last_abandoned_operation.job_id === value.owner?.job_id)) {
    context.addIssue({ code: "custom", message: "An abandoned operation must be older than the current generation and owner" });
  }
});

export const episodeLifecycleSchema = z.object({
  schema_version: z.literal(1),
  show_id: slug(32),
  episode_id: slug(80),
  lifecycle: lifecycleStateSchema,
  generation,
  last_job_id: z.uuid().optional(),
}).strict();

export const controlRequestSchema = z.object({
  schema_version: z.literal(1),
  job_id: z.uuid(),
  show_id: slug(32),
  kind: z.enum(["show", "episode"]),
  episode_id: slug(80).optional(),
  action: controlActionSchema,
  expected_show_generation: generation,
  expected_episode_generation: generation.optional(),
  created_at: z.iso.datetime({ offset: true, precision: 0 }),
}).strict().superRefine((value, context) => {
  const episode = value.kind === "episode";
  if (episode !== (value.episode_id !== undefined) ||
    episode !== (value.expected_episode_generation !== undefined)) {
    context.addIssue({ code: "custom", message: "Episode ID and generation are required only for Episode operations" });
  }
});

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type ControlAction = z.infer<typeof controlActionSchema>;
export type ShowControl = z.infer<typeof showControlSchema>;
export type EpisodeLifecycle = z.infer<typeof episodeLifecycleSchema>;
export type ControlRequest = z.infer<typeof controlRequestSchema>;

export function parseShowControl(value: unknown): ShowControl {
  return showControlSchema.parse(value);
}

export function parseEpisodeLifecycle(source: string): EpisodeLifecycle {
  return episodeLifecycleSchema.parse(TOML.parse(source));
}

export function parseControlRequest(source: string): ControlRequest {
  return controlRequestSchema.parse(TOML.parse(source));
}

export function stringifyLifecycleToml(value: EpisodeLifecycle | ControlRequest): string {
  return TOML.stringify(value as TOML.JsonMap);
}

export function permitsControlAction(state: LifecycleState, action: ControlAction): boolean {
  switch (action) {
    case "publish":
    case "stage": return state === "draft" || state === "active";
    case "unpublish": return state === "active";
    case "restore": return state === "unpublished";
    case "delete": return state === "draft" || state === "active" || state === "unpublished";
  }
}
