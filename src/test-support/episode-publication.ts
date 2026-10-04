import { episodeDraftFromRevision, parseEpisodeRevision, stagePayloadKey, stageUploadRequestSchema, stringifyToml } from "../../packages/shared/src/index";
import type { StageAsset, StageUploadRequest } from "../../packages/shared/src/index";
import { readShowControl } from "../lifecycle-control";
import { claimPublicationOperation, commitOwnedPublication, publicationRequestSchema } from "../publication-admission";
import { consumeOwnedPublication } from "../publication-consumer";
import { beginStageUpload, claimStageUpload, settleStageUpload } from "../staging-upload";
import { runStageVerification } from "../staging-verification";
import { publicationFixture } from "./publication";
import { createHash } from "node:crypto";

export async function episodePublicationFixture(update?: "metadata" | "audio") {
  const setup = await publicationFixture({ active: true, episodes: true });
  await consumeOwnedPublication(setup.env, setup.key, { async checkDeliveryGate() {}, async purge() {} });
  const episodeId = update ? "first" : "new-episode";
  const prefix = `public/episodes/daily/${episodeId}`;
  const base = update ? parseEpisodeRevision(setup.text(`${prefix}/metadata.toml`)) : null;
  const draft = base ? { ...episodeDraftFromRevision(base), title: "Updated Episode title" } : {
    schema_version: 1 as const, episode_id: episodeId, guid: crypto.randomUUID(), title: "Initial Episode title",
    description: "Private Episode description", published_at: "2026-10-01T12:00:00Z" };
  const metadata = new TextEncoder().encode(stringifyToml(draft));
  const audio = Uint8Array.from([73, 68, 51, 1, 2, 3]);
  const contents: Array<{ asset: StageAsset; bytes: Uint8Array }> = [];
  if (update !== "audio") contents.push({ asset: "episode_metadata", bytes: metadata });
  if (update !== "metadata") contents.push({ asset: "audio", bytes: audio });
  const stages: StageUploadRequest[] = [];
  const jobId = crypto.randomUUID();
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  for (const content of contents) {
    const request = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: jobId,
      show_id: "daily", kind: "episode", episode_id: episodeId, expected_episode_generation: 0,
      expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation, created_at: "2026-10-01T12:00:00Z",
      payloads: [{ asset: content.asset, length_bytes: content.bytes.length, sha256: sha256(content.bytes) }] });
    const operation = await claimStageUpload(setup.env, request);
    await beginStageUpload(setup.env, operation);
    await setup.bucket.put(stagePayloadKey(request, content.asset), content.bytes);
    await settleStageUpload(setup.env, operation, { put_requests_settled: true, no_more_puts: true, readback_receipts: setup.readbacks(request) });
    await runStageVerification(setup.env, operation, "staged");
    stages.push(request);
  }
  const frozen = publicationRequestSchema.parse({ schema_version: 1,
    request: { schema_version: 1, job_id: jobId, show_id: "daily", kind: "episode", episode_id: episodeId, action: "publish",
      expected_episode_generation: 0, expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      created_at: "2026-10-01T12:00:00Z" },
    commit: { schema_version: 1, kind: "episode", episode_id: episodeId, show_id: "daily", job_id: jobId,
      ...(base ? { base_revision_id: base.revision_id } : {}), ...(update !== "audio" ? { metadata_sha256: sha256(metadata) } : {}),
      ...(update !== "metadata" ? { audio_sha256: sha256(audio), audio_length_bytes: audio.length, duration_seconds: 2 } : {}),
      committed_at: "2026-10-01T12:00:00Z" }, staged_uploads: stages.map((request) => request.operation_id) });
  const operation = await claimPublicationOperation(setup.env, frozen);
  const { key } = await commitOwnedPublication(setup.env, operation);
  return { ...setup, operation, key, frozen, stages, episodeId, base, draft, audio,
    metadataKey: `${prefix}/metadata.toml`, historyKey: `${prefix}/revisions/${jobId}.toml`,
    mediaKey: `public/podcasts/daily/episodes/${episodeId}/${jobId}.mp3`, lifecycleKey: `system/episode-lifecycle/daily/${episodeId}.toml`,
    statusKey: `system/jobs/${jobId}/status.toml`, progressKey: `system/jobs/${jobId}/progress.toml` };
}
