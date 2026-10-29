import { z } from "zod";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteContentActionRequestSchema, sqliteDirectPublicationRequestHash } from "../../shared/src/sqlite-direct-publication";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import type { R2RestTransport } from "./bounded-http-read";

export const sqliteLifecyclePlanSchema = z.object({ request: sqliteContentActionRequestSchema.refine((value) => value.action !== "restore_revision"),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SqliteLifecyclePlan = z.infer<typeof sqliteLifecyclePlanSchema>;

export async function previewSqliteLifecycle(config: SqliteServiceConfig, key: string, showId: string, action: string,
  episodeId?: string, transport?: R2RestTransport): Promise<SqliteLifecyclePlan> {
  if (action !== "unpublish" && action !== "restore") throw new Error("SQLite deletion is not implemented");
  const target = await new SqliteServiceClient(config, key, transport).inspect(showId, episodeId);
  if (target.expected_show_state_version === null || !["published", "unpublished"].includes(target.show_lifecycle) ||
    episodeId !== undefined && (!target.base_revision_id || !["published", "unpublished"].includes(target.episode_lifecycle!))) throw new Error("Lifecycle target is unavailable");
  const request = sqliteContentActionRequestSchema.parse({ schema_version: 1, protocol: "sqlite-sequential-v1", action,
    kind: episodeId === undefined ? "show" : "episode", show_id: showId, service_id: config.service_id,
    service_config_sha256: target.service_config_sha256, expected_show_state_version: target.expected_show_state_version,
    ...(episodeId !== undefined ? { episode_id: episodeId, base_revision_id: target.base_revision_id, expected_episode_lifecycle_version: target.expected_episode_lifecycle_version } : {}) });
  return { request, request_sha256: await sqliteDirectPublicationRequestHash(request) };
}

export async function executeSqliteLifecycle(_root: string, config: SqliteServiceConfig, key: string, input: unknown,
  hash: string, confirmation: string, transport?: R2RestTransport) {
  const plan = sqliteLifecyclePlanSchema.parse(input);
  if (confirmation !== "confirm" || hash !== plan.request_sha256 || hash !== await sqliteDirectPublicationRequestHash(plan.request) ||
    plan.request.service_id !== config.service_id || plan.request.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Lifecycle execution requires the exact reviewed plan and confirm");
  return new SqlitePublicationClient(config, key, transport).submit(plan.request);
}
