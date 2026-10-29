import { validateId } from "../packages/shared/src/ids";

export function sqliteFeedSnapshotKey(showId: string, generation: number): string {
  validateId(showId, "show");
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid committed Feed generation");
  return `public/podcasts/${showId}/feeds/${generation}.xml`;
}
