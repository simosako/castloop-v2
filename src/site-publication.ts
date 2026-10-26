import type { SqlitePublicationRequest } from "../packages/shared/src/sqlite-publication";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import type { SqlitePublicationExecutor } from "./sqlite-publication-alarm";
import type { SqlitePublicationContent } from "./sqlite-publication-content";
import type { PreparedSqlitePublication, SqlitePublicationBucket } from "./sqlite-publication-executor";
import type { SiteRenderInput } from "./site-renderer";
import type { SitePurgeTarget } from "./site-storage";

export type SitePublication = { request: SqlitePublicationRequest; prepared?: PreparedSqlitePublication };

export function withSitePublication(base: SqlitePublicationExecutor<PreparedSqlitePublication>, content: SqlitePublicationContent,
  bucket: SqlitePublicationBucket, config: SqliteServiceConfig, purge: (target: SitePurgeTarget) => Promise<void>): SqlitePublicationExecutor<SitePublication> {
  return {
    async validate(request) {
      content.requireRunning(request);
      const existing = content.sites.build(request.job_id);
      if (existing) {
        if (existing.show_id !== request.show_id || existing.generation !== content.feedGeneration(request)) throw new Error("Site execution identity differs");
        return { request };
      }
      const prepared = await base.validate(request), target = content.target(request);
      const metadata = prepared.kind === "show" ? prepared.metadata : target.metadata;
      const enabled = metadata?.site_mode === "builtin" && !(request.kind === "show" && request.action === "unpublish");
      let episodes = enabled ? content.episodes(request.show_id) : [];
      if (enabled && prepared.kind === "episode") episodes = [...episodes.filter((item) => item.episode_id !== request.episode_id), prepared.revision];
      else if (enabled && request.kind === "episode" && prepared.kind === "lifecycle") {
        episodes = episodes.filter((item) => item.episode_id !== request.episode_id);
        if (request.action === "restore") episodes.push(target.base!);
      }
      const input: SiteRenderInput | null = enabled ? { origin: config.public_base_url, episodeSiteIds: content.sites.ids.all(request.show_id),
        coverExtension: prepared.kind === "show" ? prepared.extension : target.coverExtension!,
        show: { show_id: metadata.show_id, title: metadata.title, description: metadata.description, language: metadata.language,
          author: metadata.author, ...(metadata.site_timezone !== undefined ? { site_timezone: metadata.site_timezone } : {}),
          ...(metadata.site_css !== undefined ? { site_css: metadata.site_css } : {}),
          ...(metadata.copyright ? { copyright: metadata.copyright } : {}) } } : null;
      content.sites.prepare(request.job_id, prepared.feedGeneration, request.show_id, input, episodes,
        request.kind === "episode" ? request.episode_id : undefined);
      return { request, prepared };
    },
    async publish(value) {
      if (!await content.sites.batch(value.request.job_id, bucket)) return false;
      if (!value.prepared) {
        try { value.prepared = await base.validate(value.request); }
        catch { throw new Error("Retained site publication validation is unavailable"); }
      }
      await base.publish(value.prepared);
      content.sites.confirmPurge(value.request.job_id, "media");
      if (content.sites.build(value.request.job_id)!.enabled || content.sites.page({ kind: "listing", showId: value.request.show_id, page: 1 })) {
        const siteId = value.request.kind === "episode" ? content.sites.ids.get(value.request.show_id, value.request.episode_id!) : null;
        await purge({ showId: value.request.show_id, ...(siteId ? { siteId } : {}) });
      }
      content.sites.confirmPurge(value.request.job_id, "site");
    },
    commit(value) {
      if (!value.prepared) throw new Error("Site publication was not prepared");
      base.commit?.(value.prepared);
      content.sites.commit(value.request.job_id);
    },
  };
}
