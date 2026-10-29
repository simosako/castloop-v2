import { z } from "zod";
import { sameEpisodeIdentity, stringifyToml } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { sqliteContentActionRequestSchema, sqliteDirectPublicationRequestHash } from "../../shared/src/sqlite-direct-publication";
import { diffEpisodeDraftFields, diffShowMetadataFields, sqliteRevisionPlanSchema } from "../../shared/src/sqlite-revisions";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import { readBoundedLocalJournal } from "./local-journal-read";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import type { R2RestTransport } from "./verified-r2-put";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function readRevisionPlanFile(file: string): unknown {
  try { return readBoundedLocalJournal(file, 8_388_608); }
  catch { throw new Error("Revision plan JSON is unreadable, invalid or exceeds its read budget"); }
}

export async function previewRevision(config: SqliteServiceConfig, key: string, showId: string, revisionId: string,
  episodeId?: string, transport?: R2RestTransport) {
  const detail = await new SqliteServiceClient(config, key, transport).revision(showId, revisionId, episodeId);
  const current = episodeId === undefined ? detail.current_show : detail.current_episode!;
  const target = episodeId === undefined ? detail.target_show_revision! : detail.target_episode_revision!;
  const identityPreserved = episodeId === undefined || sameEpisodeIdentity(detail.current_episode!.metadata, detail.target_episode_revision!.metadata);
  const allowed = identityPreserved &&
    (episodeId === undefined ? detail.current_show.cover.extension === detail.target_show_revision!.cover.extension : detail.show_lifecycle === "published");
  const request = allowed ? sqliteContentActionRequestSchema.parse({ schema_version: 1, protocol: "sqlite-sequential-v1", action: "restore_revision",
    kind: detail.kind, show_id: showId, service_id: config.service_id,
    service_config_sha256: detail.service_config_sha256,
    expected_show_state_version: detail.expected_show_state_version, target_revision_id: revisionId,
    ...(episodeId === undefined ? {} : { episode_id: episodeId, base_revision_id: detail.current_episode!.revision_id,
      expected_episode_lifecycle_version: detail.expected_episode_lifecycle_version }) }) : null;
  return { current, target_revision: target, show_lifecycle: detail.show_lifecycle, episode_lifecycle: detail.episode_lifecycle ?? null,
    resulting_lifecycle: "published", identity_preserved: identityPreserved, executable: allowed,
    changes: episodeId === undefined ? diffShowMetadataFields(detail.current_show.metadata, detail.target_show_revision!.metadata) :
      diffEpisodeDraftFields(detail.current_episode!.metadata, detail.target_episode_revision!.metadata),
    assets: episodeId === undefined ? { current: detail.current_show.cover, candidate: detail.target_show_revision!.cover, mode: "reuse_saved_cover" } :
      { current: detail.current_episode!.audio, candidate: detail.target_episode_revision!.audio, mode: "reuse_saved_audio" },
    plan: request ? { request, request_sha256: await sqliteDirectPublicationRequestHash(request) } : null };
}

export async function executeRevision(_root: string, config: SqliteServiceConfig, key: string, input: unknown,
  hash: string, confirmation: string, transport?: R2RestTransport) {
  const direct = sqliteRevisionPlanSchema.safeParse(input), preview = z.object({ plan: sqliteRevisionPlanSchema }).safeParse(input);
  const plan = direct.success ? direct.data : preview.success ? preview.data.plan : z.object({ result: z.object({ plan: sqliteRevisionPlanSchema }) }).parse(input).result.plan;
  if (confirmation !== "confirm" || hash !== plan.request_sha256 || hash !== await sqliteDirectPublicationRequestHash(plan.request) ||
    plan.request.service_id !== config.service_id || plan.request.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Revision execution requires the exact reviewed plan and confirm");
  return new SqlitePublicationClient(config, key, transport).submit(plan.request);
}

export async function syncLocalMetadata(root: string, config: SqliteServiceConfig, key: string, showId: string,
  expectedRevision: string, episodeId?: string, output?: string, transport?: R2RestTransport) {
  z.uuid().parse(expectedRevision);
  const snapshot = await new SqliteServiceClient(config, key, transport).content(showId, episodeId);
  const content = episodeId === undefined ? snapshot.show_content : snapshot.episode_content;
  if (!content || content.revision_id !== expectedRevision) throw new Error("Current revision differs from the reviewed revision");
  const file = output ? resolve(output) : join(root, showId, episodeId === undefined ? "show.toml" : `episode-${episodeId}.toml`);
  for (let parent = dirname(file);; parent = dirname(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error("Metadata output parents must be real directories");
    if (dirname(parent) === parent) break;
  }
  writeSyncedLocalFile(file, () => stringifyToml(content.metadata));
  syncLocalJournalDirectory(dirname(file));
  return { path: file, revision_id: content.revision_id, result: "metadata_exported", assets_downloaded: false, existing_files_overwritten: false };
}
