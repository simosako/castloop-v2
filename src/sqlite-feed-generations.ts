import { z } from "zod";
import { sqlitePublicationRequestSchema, sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";

export const SQLITE_QUEUE_SCHEMA_VERSION = 7;
export const SQLITE_CONTENT_SCHEMA_VERSION = 8;
const reservationSchema = z.object({ kind: z.enum(["publication", "domain"]), id: z.uuid(),
  showId: sqlitePublicationRequestSchema.shape.show_id,
  requestSha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256 }).strict();
export type SqliteFeedReservation = z.infer<typeof reservationSchema>;

export function initializeSqliteFeedGenerations(storage: PublicationQueueStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_feed_generations (
    generation INTEGER PRIMARY KEY AUTOINCREMENT, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('publication', 'domain')),
    owner_id TEXT NOT NULL, show_id TEXT NOT NULL, request_sha256 TEXT NOT NULL,
    UNIQUE(owner_kind, owner_id))`);
}

export function reserveSqliteFeedGeneration(storage: PublicationQueueStorage, input: SqliteFeedReservation): number {
  const reservation = reservationSchema.parse(input);
  return storage.transactionSync(() => {
    const existing = storage.sql.exec<{ generation: number; show_id: string; request_sha256: string }>(
      "SELECT generation, show_id, request_sha256 FROM publication_feed_generations WHERE owner_kind = ? AND owner_id = ?",
      reservation.kind, reservation.id).toArray()[0];
    if (existing) {
      if (existing.show_id !== reservation.showId || existing.request_sha256 !== reservation.requestSha256 ||
        !Number.isSafeInteger(existing.generation) || existing.generation < 1) throw new Error("Keep the frozen Feed generation reservation");
      return existing.generation;
    }
    const sequence = storage.sql.exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'publication_feed_generations'").toArray()[0]?.seq ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Feed generation space is exhausted");
    return storage.sql.exec<{ generation: number }>(`INSERT INTO publication_feed_generations
      (owner_kind, owner_id, show_id, request_sha256) VALUES (?, ?, ?, ?) RETURNING generation`,
    reservation.kind, reservation.id, reservation.showId, reservation.requestSha256).toArray()[0].generation;
  });
}
