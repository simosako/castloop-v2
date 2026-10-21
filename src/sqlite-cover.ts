import { validateId } from "../packages/shared/src/ids";

export type SqliteCoverIdentity = { generation: number; sha256: string; lengthBytes: number };

export function validSqliteCoverIdentity(cover: SqliteCoverIdentity): boolean {
  return Number.isSafeInteger(cover.generation) && cover.generation > 0 &&
    /^[a-f0-9]{64}$/.test(cover.sha256) && Number.isSafeInteger(cover.lengthBytes) &&
    cover.lengthBytes > 0 && cover.lengthBytes <= 5_000_000;
}

export function sqliteCoverSnapshotKey(showId: string, generation: number, extension: "jpg" | "png"): string {
  validateId(showId, "show");
  if (!Number.isSafeInteger(generation) || generation < 1 || !["jpg", "png"].includes(extension)) {
    throw new Error("Invalid committed cover reference");
  }
  return `public/podcasts/${showId}/covers/${generation}.${extension}`;
}
