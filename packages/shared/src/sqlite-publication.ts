import { z } from "zod";

export const sqlitePublicationProtocol = "sqlite-sequential-v1" as const;
export const MAX_SQLITE_PUBLICATION_BYTES = 16384;
const slug = (maximum: number) => z.string().max(maximum).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const assetSchema = z.enum(["show_metadata", "episode_metadata", "cover_jpg", "cover_png", "audio"]);
const uploadIdentitySchema = z.object({ show_id: slug(32), draft_job_id: z.uuid(), upload_id: z.uuid(), asset: assetSchema }).strict();

export type SqliteUploadIdentity = z.infer<typeof uploadIdentitySchema>;

export function sqliteUploadKey(input: SqliteUploadIdentity): string {
  const value = uploadIdentitySchema.parse(input);
  const file = { show_metadata: "show.toml", episode_metadata: "episode.toml", cover_jpg: "cover.jpg",
    cover_png: "cover.png", audio: "audio.mp3" }[value.asset];
  return `staging/uploads/${value.show_id}/${value.draft_job_id}/${value.upload_id}/${file}`;
}

export const sqliteVerifiedUploadSchema = z.object({ upload_id: z.uuid(), asset: assetSchema,
  key: z.string().min(1).max(256), length_bytes: z.number().int().positive().max(300_000_000), sha256: hash,
  etag: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/), verified: z.literal(true),
  duration_seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().superRefine((value, context) => {
  if ((value.asset === "audio") !== (value.duration_seconds !== undefined) ||
    value.asset.endsWith("metadata") && value.length_bytes > 1_000_000 ||
    value.asset.startsWith("cover_") && value.length_bytes > 10_000_000) {
    context.addIssue({ code: "custom", message: "Verified upload has invalid asset size or duration" });
  }
});

export const sqlitePublicationRuntimeSchema = z.object({ service_id: slug(20), worker_version_id: z.uuid(),
  service_config_sha256: hash }).strict();

export const sqlitePublicationRequestSchema = z.object({ schema_version: z.literal(1),
  protocol: z.literal(sqlitePublicationProtocol), service_id: slug(20), request_id: z.uuid(), job_id: z.uuid(),
  action: z.literal("publish"), kind: z.enum(["show", "episode"]), show_id: slug(32), episode_id: slug(80).optional(),
  worker_version_id: z.uuid(), service_config_sha256: hash, admission_window_id: z.uuid(),
  expected_show_state_version: counter, base_revision_id: z.uuid().optional(),
  payloads: z.array(sqliteVerifiedUploadSchema).min(1).max(2),
}).strict().superRefine((value, context) => {
  const assets = value.payloads.map((payload) => payload.asset);
  const validKind = value.kind === "episode" ? value.episode_id !== undefined &&
    assets.every((asset) => asset === "episode_metadata" || asset === "audio") &&
    (value.base_revision_id !== undefined || assets.includes("episode_metadata") && assets.includes("audio")) :
    value.episode_id === undefined && value.base_revision_id === undefined && assets.includes("show_metadata") &&
    (assets.includes("cover_jpg") || assets.includes("cover_png"));
  if (!validKind || new Set(assets).size !== assets.length ||
    new Set(value.payloads.map((payload) => payload.upload_id)).size !== value.payloads.length ||
    value.payloads.some((payload) => payload.key !== sqliteUploadKey({ show_id: value.show_id,
      draft_job_id: value.job_id, upload_id: payload.upload_id, asset: payload.asset }))) {
    context.addIssue({ code: "custom", message: "Publication payloads do not match their frozen target or upload keys" });
  }
});

export const sqlitePublicationFailureSchema = z.enum(["validation_failed", "base_conflict", "target_unavailable",
  "stale_window", "runtime_mismatch"]);
export const sqlitePublicationBlockSchema = z.enum(["execution_interrupted", "validation_unavailable", "execution_failed"]);
export const sqlitePublicationStatusSchema = z.object({ protocol: z.literal(sqlitePublicationProtocol),
  service_id: slug(20), request_id: z.uuid(), job_id: z.uuid(), request_sha256: hash,
  sequence: counter.refine((value) => value > 0), state: z.enum(["queued", "running", "succeeded", "failed", "blocked"]),
  reason_code: z.union([sqlitePublicationFailureSchema, sqlitePublicationBlockSchema]).optional(),
}).strict().superRefine((value, context) => {
  if (value.state === "failed" ? !sqlitePublicationFailureSchema.safeParse(value.reason_code).success :
    value.state === "blocked" ? !sqlitePublicationBlockSchema.safeParse(value.reason_code).success : value.reason_code !== undefined) {
    context.addIssue({ code: "custom", message: "Publication state and reason code differ" });
  }
});

export type SqliteVerifiedUpload = z.infer<typeof sqliteVerifiedUploadSchema>;
export type SqlitePublicationRuntime = z.infer<typeof sqlitePublicationRuntimeSchema>;
export type SqlitePublicationRequest = z.infer<typeof sqlitePublicationRequestSchema>;
export type SqlitePublicationStatus = z.infer<typeof sqlitePublicationStatusSchema>;
export type SqlitePublicationFailure = z.infer<typeof sqlitePublicationFailureSchema>;
export type SqlitePublicationBlock = z.infer<typeof sqlitePublicationBlockSchema>;

export function parseSqlitePublicationRequest(input: unknown): SqlitePublicationRequest {
  const value = sqlitePublicationRequestSchema.parse(input);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SQLITE_PUBLICATION_BYTES) {
    throw new Error("SQLite publication request exceeds its size limit");
  }
  return value;
}

export async function sqlitePublicationRequestHash(input: SqlitePublicationRequest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parseSqlitePublicationRequest(input)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
