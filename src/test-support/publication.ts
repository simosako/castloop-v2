import { episodeRevisionSchema, stagePayloadKey, stageUploadRequestSchema, stringifyLifecycleToml, stringifyToml } from "../../packages/shared/src/index";
import type { LifecycleState } from "../../packages/shared/src/index";
import { readShowControl } from "../lifecycle-control";
import { claimPublicationOperation, commitOwnedPublication, publicationRequestSchema } from "../publication-admission";
import { beginStageUpload, claimStageUpload, settleStageUpload } from "../staging-upload";
import { runStageVerification } from "../staging-verification";
import { reserveM6Show } from "../show-registration";
import { createHash } from "node:crypto";

export const PUBLICATION_SHOW_TEXT = "schema_version = 1\nshow_id = 'daily'\ntitle = 'New Show title'\ndescription = 'Private description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n";
export const PUBLICATION_SERVICE_TEXT = "schema_version = 1\nservice_id = 'service'\naccount_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nbucket_name = 'test-bucket'\nworker_name = 'test-worker'\nqueue_name = 'test-queue'\ndlq_name = 'test-dlq'\npublic_base_url = 'https://current.example'\n";

type Entry = { bytes: Uint8Array; size: number; etag: string; customMetadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata };
type PutOptions = Pick<R2PutOptions, "onlyIf" | "customMetadata" | "httpMetadata" | "sha256">;

export async function publicationFixture(options: { active?: boolean; episodes?: boolean } = {}) {
  const entries = new Map<string, Entry>();
  const writes: string[] = [];
  const bodyReads: string[] = [];
  let version = 0;
  const bucket = {
    async head(key: string) { const entry = entries.get(key); return entry ? { key, ...entry } : null; },
    async get(key: string, options?: R2GetOptions) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches && options.onlyIf.etagMatches !== entry.etag) {
        return { key, ...entry };
      }
      bodyReads.push(key);
      return { key, ...entry, body: new Blob([entry.bytes]).stream(),
        async arrayBuffer() { if (key.endsWith(".mp3")) throw new Error("Audio must not be buffered by the application"); return entry.bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(entry.bytes); },
        async json() { return JSON.parse(new TextDecoder().decode(entry.bytes)); } };
    },
    async put(key: string, input: string | Uint8Array | ArrayBuffer | ReadableStream, options?: PutOptions) {
      const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input.slice() :
        input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : new Uint8Array(await new Response(input).arrayBuffer());
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== previous?.etag) return null;
      if (typeof options?.sha256 === "string" && createHash("sha256").update(bytes).digest("hex") !== options.sha256) throw new Error("Checksum mismatch");
      const entry: Entry = { bytes, size: bytes.length, etag: String(++version),
        ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
        ...(options?.httpMetadata && !(options.httpMetadata instanceof Headers) ? { httpMetadata: options.httpMetadata } : {}) };
      entries.set(key, entry);
      writes.push(key);
      return { key, ...entry };
    },
    async list(options: { prefix: string; cursor?: string; limit?: number }) {
      const objects = [...entries].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => ({ key, ...entry }));
      const start = Number(options.cursor ?? 0);
      const end = start + (options.limit ?? 1000);
      return { objects: objects.slice(start, end), truncated: end < objects.length, cursor: String(end) };
    },
    async delete(input: string | string[]) { for (const key of typeof input === "string" ? [input] : input) entries.delete(key); },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  await bucket.put("system/service.toml", PUBLICATION_SERVICE_TEXT);
  if (options.active) await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: "active", generation: 0, feed_generation: 0 }));
  else await reserveM6Show(env, { schema_version: 1, service_id: "service", show_id: "daily", reservation_id: crypto.randomUUID(), action: "reserve" });
  if (options.active) {
    await bucket.put("system/shows/daily/show.toml", PUBLICATION_SHOW_TEXT.replace("New Show title", "Old Show title"));
    await bucket.put("public/podcasts/daily/cover.jpg", Uint8Array.from([255, 216, 255, 1]));
    await bucket.put("public/podcasts/daily/feed.xml", "old feed");
  }
  async function addEpisode(episodeId: string, lifecycle: LifecycleState) {
    await bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml({ schema_version: 1,
      show_id: "daily", episode_id: episodeId, lifecycle, generation: 0 }));
    if (lifecycle === "draft" || lifecycle === "deleted") return null;
    const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
      title: `Saved ${episodeId}`, description: "Saved description", published_at: "2026-09-01T12:34:56+09:00",
      revision_id: crypto.randomUUID(), enclosure_url: `https://old.example/podcasts/daily/episodes/${episodeId}/${crypto.randomUUID()}.mp3`,
      content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: createHash("sha256").update("x").digest("hex"), updated_at: "2026-09-02T00:00:00Z" });
    await bucket.put(`public/episodes/daily/${episodeId}/metadata.toml`, stringifyToml(revision));
    await bucket.put(`public/episodes/daily/${episodeId}/revisions/${revision.revision_id}.toml`, stringifyToml(revision));
    await bucket.put(`public${new URL(revision.enclosure_url).pathname}`, "x", { customMetadata: { sha256: revision.sha256 } });
    return revision;
  }
  if (options.episodes) for (const [episodeId, lifecycle] of [["first", "active"], ["second", "active"], ["stopped", "unpublished"],
    ["draft", "draft"], ["deleted", "deleted"]] as const) await addEpisode(episodeId, lifecycle);
  const metadata = new TextEncoder().encode(PUBLICATION_SHOW_TEXT);
  const cover = Uint8Array.from([255, 216, 255, 2]);
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const stage = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    show_id: "daily", kind: "show", expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    payloads: [{ asset: "show_metadata", length_bytes: metadata.length, sha256: sha256(metadata) },
      { asset: "cover_jpg", length_bytes: cover.length, sha256: sha256(cover) }] });
  const upload = await claimStageUpload(env, stage);
  await beginStageUpload(env, upload);
  await bucket.put(stagePayloadKey(stage, "show_metadata"), metadata);
  await bucket.put(stagePayloadKey(stage, "cover_jpg"), cover);
  await settleStageUpload(env, upload, { put_requests_settled: true, no_more_puts: true });
  await runStageVerification(env, upload, "staged");
  const frozen = publicationRequestSchema.parse({ schema_version: 1,
    request: { schema_version: 1, job_id: stage.draft_job_id, show_id: "daily", kind: "show", action: "publish",
      expected_show_generation: (await readShowControl(env, "daily"))!.value.generation, created_at: "2026-10-01T12:00:00Z" },
    commit: { schema_version: 1, kind: "show", job_id: stage.draft_job_id, show_id: "daily", metadata_sha256: sha256(metadata),
      cover_sha256: sha256(cover), cover_extension: "jpg" }, staged_uploads: [stage.operation_id] });
  const operation = await claimPublicationOperation(env, frozen);
  const { key } = await commitOwnedPublication(env, operation);
  return { bucket, env, entries, writes, bodyReads, addEpisode, operation, key, frozen, stage,
    text: (key: string) => new TextDecoder().decode(entries.get(key)?.bytes), feedKey: "public/podcasts/daily/feed.xml",
    statusKey: `system/jobs/${operation.jobId}/status.toml`, progressKey: `system/jobs/${operation.jobId}/progress.toml` };
}
