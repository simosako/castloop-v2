import { z } from "zod";
import { episodeLifecycleSchema, showControlSchema } from "./lifecycle";
import { serviceAdmissionSchema } from "./service-admission";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = "[a-f0-9-]{36}";
const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const sourcePatterns = [
  /^system\/service\.toml$/,
  new RegExp(`^system/(?:show-reservations|show-publications)/${slug}\\.json$`),
  new RegExp(`^system/shows/${slug}/show\\.toml$`),
  new RegExp(`^system/episode-lifecycle/${slug}/${slug}\\.toml$`),
  new RegExp(`^system/jobs/${uuid}/(?:request\\.toml|progress\\.toml|status\\.toml|upload\\.json|upload-progress\\.json|publication\\.json|dlq\\.json)$`),
  new RegExp(`^system/dlq/unmatched/${uuid}\\.json$`),
  new RegExp(`^public/podcasts/${slug}/(?:feed\\.xml|cover\\.(?:jpg|png)|episodes/${slug}/${uuid}\\.mp3)$`),
  new RegExp(`^public/episodes/${slug}/${slug}/(?:metadata\\.toml|revisions/${uuid}\\.toml)$`),
  new RegExp(`^staging/shows/${slug}/${uuid}/(?:show\\.toml|cover\\.(?:jpg|png)|commit\\.json)$`),
  new RegExp(`^staging/episodes/${slug}/${slug}/${uuid}/(?:episode\\.toml|audio\\.mp3|commit\\.json)$`),
];

export const frozenMigrationPlanSchema = z.object({
  schema_version: z.literal(1), migration_id: z.uuid(), service_id: serviceAdmissionSchema.shape.service_id,
  request_sha256: checksum,
  sources: z.array(z.object({
    key: z.string().max(1024).refine((key) => sourcePatterns.some((pattern) => pattern.test(key)), "Unknown migration source key"),
    etag: z.string().max(128).regex(/^[a-zA-Z0-9_-]+$/), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(10000),
  shows: z.array(z.object({
    show_id: showControlSchema.shape.show_id, mode: z.enum(["initialize", "preserve"]), value: showControlSchema,
    episodes: z.array(z.object({ episode_id: episodeLifecycleSchema.shape.episode_id, mode: z.enum(["initialize", "preserve"]),
      value: episodeLifecycleSchema }).strict()).max(10000),
  }).strict()).max(10000),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (new Set(value.sources.map((source) => source.key)).size !== value.sources.length ||
    new Set(value.shows.map((show) => show.show_id)).size !== value.shows.length) fail("Migration sources and targets must be unique");
  let targets = 0;
  for (const show of value.shows) {
    targets += show.episodes.length + 1;
    if (show.show_id !== show.value.show_id || show.value.owner || show.value.lifecycle === "deleting") fail("Migration cannot change a busy or mismatched Show");
    if (show.mode === "initialize" && JSON.stringify(show.value) !== JSON.stringify(showControlSchema.parse({ schema_version: 2,
      show_id: show.show_id, lifecycle: show.value.lifecycle, generation: 0, feed_generation: 0 }))) fail("Initialized Show controls must be minimal generation-zero records");
    if (show.mode === "initialize" && !["draft", "active"].includes(show.value.lifecycle)) fail("Legacy Shows can only initialize as draft or active");
    if (new Set(show.episodes.map((episode) => episode.episode_id)).size !== show.episodes.length) fail("Migration Episode targets must be unique");
    for (const episode of show.episodes) {
      if (episode.episode_id !== episode.value.episode_id || episode.value.show_id !== show.show_id || episode.value.lifecycle === "deleting") fail("Migration Episode target is inconsistent");
      if (episode.mode === "initialize" && (episode.value.generation !== 0 || episode.value.last_job_id || !["draft", "active"].includes(episode.value.lifecycle))) {
        fail("Legacy Episodes must initialize as generation-zero draft or active");
      }
    }
  }
  if (targets > 10000) fail("Migration exceeds its control-record budget");
});

export type FrozenMigrationPlan = z.infer<typeof frozenMigrationPlanSchema>;
export const migrationRuntimeProofSchema = serviceAdmissionSchema.shape.readiness.unwrap().omit({
  migration_id: true, plan_sha256: true, completed_execution_id: true,
});
export type MigrationRuntimeProof = z.infer<typeof migrationRuntimeProofSchema>;
export const migrationApplyProgressSchema = z.object({
  schema_version: z.literal(1), migration_id: z.uuid(), service_id: serviceAdmissionSchema.shape.service_id,
  request_sha256: checksum, plan_sha256: checksum,
  phase: z.enum(["applying", "verifying", "runtime", "finished"]), next_target: z.number().int().nonnegative().max(10000),
  runtime: migrationRuntimeProofSchema.optional(), completed_execution_id: z.uuid().optional(),
  reason_code: z.enum(["migration_inventory_failed", "migration_apply_failed", "migration_runtime_failed"]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.phase === "finished") !== (value.runtime !== undefined && value.completed_execution_id !== undefined) ||
    value.phase !== "finished" && (value.runtime !== undefined || value.completed_execution_id !== undefined) ||
    value.phase === "finished" && value.reason_code !== undefined) {
    context.addIssue({ code: "custom", message: "Finished migration requires complete runtime evidence and no failure diagnostic" });
  }
});
export type MigrationApplyProgress = z.infer<typeof migrationApplyProgressSchema>;
