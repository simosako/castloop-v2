import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sqliteAudioReferenceSchema = z.object({
  sha256: hash,
  length_bytes: z.number().int().positive().max(300_000_000),
  duration_seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const sqliteCoverReferenceSchema = z.object({
  sha256: hash,
  length_bytes: z.number().int().positive().max(5_000_000),
  extension: z.enum(["jpg", "png"]),
}).strict();

export type SqliteAudioReference = z.infer<typeof sqliteAudioReferenceSchema>;
export type SqliteCoverReference = z.infer<typeof sqliteCoverReferenceSchema>;

export function sqliteMediaKey(showId: string, media: { sha256: string; extension?: "jpg" | "png" }): string {
  z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(showId);
  hash.parse(media.sha256);
  if (media.extension !== undefined) return `public/podcasts/${showId}/covers/${media.sha256}.${z.enum(["jpg", "png"]).parse(media.extension)}`;
  return `public/podcasts/${showId}/audio/${media.sha256}.mp3`;
}
