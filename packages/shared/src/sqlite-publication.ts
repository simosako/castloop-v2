import { z } from "zod";

export const sqlitePublicationProtocol = "sqlite-sequential-v1" as const;
export const MAX_SQLITE_PUBLICATION_BYTES = 16384;
const slug = (maximum: number) => z.string().max(maximum).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const sqlitePublicationRuntimeSchema = z.object({ service_id: slug(20), worker_version_id: z.uuid(),
  service_config_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const sqlitePublicationTargetSchema = z.object({ kind: z.enum(["show", "episode"]), show_id: slug(32), episode_id: slug(80).optional() });
export const sqlitePublicationFailureSchema = z.enum(["validation_failed", "base_conflict", "target_unavailable", "stale_window", "runtime_mismatch"]);
export type SqlitePublicationRuntime = z.infer<typeof sqlitePublicationRuntimeSchema>;
export type SqlitePublicationFailure = z.infer<typeof sqlitePublicationFailureSchema>;
