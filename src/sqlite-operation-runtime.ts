import { SqliteOperationRecords } from "./sqlite-operation-records";
import type { PublicationQueueStorage, SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { SqlitePublicationContent } from "./sqlite-publication-content";

export function createSqliteOperationRecords(storage: PublicationQueueStorage, queue: SqlitePublicationQueue,
  content: SqlitePublicationContent, ready: () => boolean, showId?: string,
  hasScheduledJob: (jobId: string) => boolean = () => false) {
  const records = new SqliteOperationRecords(storage, () => queue.identity(), (operation) => {
    if (!ready() || showId !== undefined && operation.show_id !== showId) return false;
    const service = queue.snapshot();
    if (service.state !== "open" || operation.admission_window_id && operation.admission_window_id !== service.admission_window_id) return false;
    const target = content.inspect(operation.show_id, operation.episode_id ?? undefined);
    if (operation.kind !== "upload") return target.show?.lifecycle !== "deleted";
    return !!target.show && ["draft", "published"].includes(target.show.lifecycle) &&
      target.show.state_version === operation.expected_show_state_version &&
      (target.episode?.lifecycle_version ?? 0) === (operation.expected_episode_lifecycle_version ?? 0) &&
      (!target.episode || target.episode.lifecycle === "published") &&
      (target.base?.revision_id ?? null) === (operation.base_revision_id ?? null);
  }, Date.now, hasScheduledJob);
  queue.operationRecords = records;
  return records;
}
