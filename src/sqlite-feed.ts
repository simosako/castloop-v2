import { validateId } from "../packages/shared/src/ids";
import type { SqlitePublicationRequest } from "../packages/shared/src/sqlite-publication";

export function sqliteFeedSnapshotKey(showId: string, generation: number): string {
  validateId(showId, "show");
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid committed Feed generation");
  return `public/podcasts/${showId}/feeds/${generation}.xml`;
}

export function sqliteDeliveryPolicy(request: SqlitePublicationRequest): "exclusive" | "preserve_committed" {
  return request.action === "publish" || request.action === "restore_revision" ?
    "preserve_committed" : "exclusive";
}
