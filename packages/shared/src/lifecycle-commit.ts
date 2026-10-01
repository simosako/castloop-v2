import { z } from "zod";

const commitTargetSchema = z.object({
  kind: z.enum(["show", "episode"]),
  show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  job_id: z.uuid(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode commits require an Episode ID" });
  }
});

export const lifecycleCommitSchema = z.object({
  schema_version: z.literal(1),
  kind: commitTargetSchema.shape.kind,
  show_id: commitTargetSchema.shape.show_id,
  episode_id: commitTargetSchema.shape.episode_id,
  job_id: commitTargetSchema.shape.job_id,
  action: z.enum(["unpublish", "restore", "delete"]),
  show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode commits require an Episode ID" });
  }
});

export type LifecycleCommit = z.infer<typeof lifecycleCommitSchema>;
export type LifecycleCommitTarget = z.infer<typeof commitTargetSchema>;

export function lifecycleCommitKey(input: LifecycleCommitTarget): string {
  const target = commitTargetSchema.parse(input);
  return target.kind === "show"
    ? `staging/lifecycle/shows/${target.show_id}/${target.job_id}/commit.json`
    : `staging/lifecycle/episodes/${target.show_id}/${target.episode_id}/${target.job_id}/commit.json`;
}

export function parseLifecycleCommitKey(key: string): LifecycleCommitTarget | null {
  const parts = key.split("/");
  if (parts[0] !== "staging" || parts[1] !== "lifecycle" || parts.at(-1) !== "commit.json") return null;
  const show = parts.length === 6 && parts[2] === "shows";
  const episode = parts.length === 7 && parts[2] === "episodes";
  if (!show && !episode) return null;
  const result = commitTargetSchema.safeParse({ kind: show ? "show" : "episode", show_id: parts[3],
    job_id: parts.at(-2), ...(episode ? { episode_id: parts[4] } : {}) });
  return result.success ? result.data : null;
}
