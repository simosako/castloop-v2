import { parseSqliteDirectPublicationRequest } from "../../packages/shared/src/sqlite-direct-publication";
import type { SqliteDirectPublishRequest } from "../../packages/shared/src/sqlite-direct-publication";
import { sqliteServiceConfigHash } from "../../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../packages/shared/src/sqlite-service";
import { sqlitePublicationFixture } from "./sqlite-publication";
import { sqlitePublicationBucket } from "./sqlite-publication-bucket";
import { initializeSqliteDomains, pendingSqliteDomain } from "../sqlite-domain-runtime";
import { SqlitePublicationContent } from "../sqlite-publication-content";
import { createSqlitePublicationExecutor } from "../sqlite-publication-executor";

export const directShow = { schema_version: 1 as const, show_id: "daily", title: "Show", description: "Description", language: "ja", author: "Author",
  owner_name: "Owner", owner_email: "private@example.com", categories: ["Technology"], explicit: false, image_path: "cover.jpg", site_mode: "builtin" as const };
export const directEpisode = (id = "first") => ({ schema_version: 1 as const, episode_id: id, guid: `saved-${id}`, title: `Episode ${id}`,
  description: "Description", published_at: "2026-10-16T12:00:00+09:00" });
export const directCover = { sha256: "b".repeat(64), length_bytes: 4, extension: "jpg" as const };
export const directAudio = { sha256: "c".repeat(64), length_bytes: 7, duration_seconds: 10 };

export async function directPublicationFixture() {
  const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service",
    account_id: "a".repeat(32), bucket_name: "test-bucket", worker_name: "test-worker", public_base_url: "https://public.example.com", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  let domainStorage: ReturnType<typeof sqlitePublicationFixture>["storage"];
  const fixture = sqlitePublicationFixture({ runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(), service_config_sha256: await sqliteServiceConfigHash(config) },
    scope: { showId: "daily", ready: () => !pendingSqliteDomain(domainStorage) } });
  domainStorage = fixture.storage;
  initializeSqliteDomains(domainStorage);
  const content = new SqlitePublicationContent(fixture.storage), objects = sqlitePublicationBucket();
  const purges: string[] = [], hooks: { purge?: () => Promise<void> } = {};
  fixture.queue.executor = createSqlitePublicationExecutor(content, config, {
    async purge() { purges.push("media"); await hooks.purge?.(); }, async purgeSite() { purges.push("site"); },
  });
  content.registerShow("daily", crypto.randomUUID());
  const common = () => ({ schema_version: 1, protocol: "sqlite-sequential-v1", ...fixture.identity,
    show_id: "daily", expected_show_state_version: content.inspect("daily").show!.state_version });
  const show = () => {
    const request = parseSqliteDirectPublicationRequest({ ...common(), action: "publish", kind: "show", metadata: directShow, cover: directCover });
    if (request.action !== "publish" || request.kind !== "show") throw new Error("Unexpected fixture kind"); return request;
  };
  const episode = (id = "first") => {
    const target = content.inspect("daily", id);
    const request = parseSqliteDirectPublicationRequest({ ...common(), action: "publish", kind: "episode", episode_id: id, metadata: directEpisode(id), audio: directAudio,
      base_revision_id: target.base?.revision_id, expected_episode_lifecycle_version: target.episode?.lifecycle_version ?? 0 });
    if (request.action !== "publish" || request.kind !== "episode") throw new Error("Unexpected fixture kind"); return request;
  };
  const action = (action: "unpublish" | "restore" | "restore_revision", episodeId?: string, revisionId?: string) => {
    const target = content.inspect("daily", episodeId);
    return parseSqliteDirectPublicationRequest({ ...common(), action, kind: episodeId ? "episode" : "show", ...(episodeId ? {
      episode_id: episodeId, base_revision_id: target.base?.revision_id, expected_episode_lifecycle_version: target.episode?.lifecycle_version ?? 0 } : {}), target_revision_id: revisionId });
  };
  const publish = (request: SqliteDirectPublishRequest) => fixture.queue.publish(request);
  return { ...fixture, ...objects, config, content, purges, hooks, show, episode, action, publish };
}
