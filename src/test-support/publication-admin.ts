import { episodeDraftFromRevision, publicationAdminResponseSchema, publicationRequestSchema, stagePayloadKey, stageUploadRequestSchema,
  stringifyToml } from "../../packages/shared/src/index";
import type { PublicationAdminResponse, StageAsset, StageUploadRequest } from "../../packages/shared/src/index";
import { readShowControl } from "../lifecycle-control";
import type { LifecyclePurgeTarget } from "../lifecycle-cache";
import type { M6CachedLoopback, M6CandidateEnv } from "../m6-routes";
import { handleM6PublicationAdmin } from "../publication-admin";
import type { PublicationAdminEnv } from "../publication-admin";
import type { StagingAdminEnv } from "../staging-admin";
import { stagingAdminFixture } from "./staging-admin";
import { createHash } from "node:crypto";

export async function publicationAdminFixture(mode: "show" | "episode" | "metadata" | "audio" = "show") {
  const setup = await stagingAdminFixture(mode === "show" ? "show" : "audio");
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const base = mode === "metadata" || mode === "audio" ? await setup.addEpisode("next", "active") : null;
  const draft = base ? { ...episodeDraftFromRevision(base), title: "Changed Episode title" } : {
    schema_version: 1 as const, episode_id: "next", guid: crypto.randomUUID(), title: "New Episode title", description: "Private Episode description",
    published_at: "2026-10-02T12:00:00Z",
  };
  const metadata = new TextEncoder().encode(mode === "show" ? "" : stringifyToml(draft));
  const stages: StageUploadRequest[] = [];
  const stagePayload = async (upload: StageUploadRequest, contents: Array<{ asset: StageAsset; bytes: Uint8Array }>) => {
    const operation = { show_id: upload.show_id, operation_id: upload.operation_id, show_generation: upload.expected_show_generation + 1 };
    await setup.success(setup.input("claim", { upload }));
    await setup.success(setup.input("begin", { operation }));
    for (const { asset, bytes } of contents) await setup.bucket.put(stagePayloadKey(upload, asset), bytes);
    await setup.success(setup.input("settle", { operation, put_requests_settled: true, no_more_puts: true }));
    await setup.success(setup.input("finish", { operation, outcome: "staged" }));
    stages.push(upload);
  };
  if (mode !== "metadata") await stagePayload(setup.upload, setup.contents);
  if (mode === "episode" || mode === "metadata") {
    const upload = stageUploadRequestSchema.parse({ ...setup.upload, operation_id: crypto.randomUUID(),
      expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      payloads: [{ asset: "episode_metadata", length_bytes: metadata.length, sha256: sha256(metadata) }] });
    await stagePayload(upload, [{ asset: "episode_metadata", bytes: metadata }]);
  }
  const frozen = publicationRequestSchema.parse({ schema_version: 1,
    request: { schema_version: 1, job_id: setup.upload.draft_job_id, show_id: "daily", kind: mode === "show" ? "show" : "episode", action: "publish",
      expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
      ...(mode !== "show" ? { episode_id: "next", expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z" },
    commit: mode === "show" ? { schema_version: 1, kind: "show", show_id: "daily", job_id: setup.upload.draft_job_id,
      metadata_sha256: setup.upload.payloads[0]!.sha256, cover_sha256: setup.upload.payloads[1]!.sha256, cover_extension: "jpg" } : {
      schema_version: 1, kind: "episode", show_id: "daily", episode_id: "next", job_id: setup.upload.draft_job_id,
      ...(base ? { base_revision_id: base.revision_id } : {}), ...(mode !== "audio" ? { metadata_sha256: sha256(metadata) } : {}),
      ...(mode !== "metadata" ? { audio_sha256: setup.upload.payloads[0]!.sha256, audio_length_bytes: setup.upload.payloads[0]!.length_bytes, duration_seconds: 2 } : {}),
      committed_at: "2026-10-02T12:00:00Z",
    }, staged_uploads: stages.map((stage) => stage.operation_id) });
  const publicationOperation = { show_id: "daily", job_id: frozen.request.job_id, show_generation: frozen.request.expected_show_generation + 1 };
  const sent: string[] = [];
  const env: PublicationAdminEnv & StagingAdminEnv = { ...setup.env, CASTLOOP_QUEUE: { send: async (body) => {
    sent.push((body as { object: { key: string } }).object.key);
  } } };
  const body = (action: "claim" | "commit" | "retry") => ({ schema_version: 1, service_id: "service", action,
    ...(action === "claim" ? { publication: frozen } : { operation: publicationOperation,
      manifest_sha256: sha256(new TextEncoder().encode(JSON.stringify(frozen))) }) });
  const http = (input: unknown, secret = "private-secret", method = "POST") => new Request("https://current.example/admin/publication", {
    method, headers: { "X-Castloop-Key": secret }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  const call = async (input: unknown) => {
    const response = await handleM6PublicationAdmin(http(input), env, setup.bindings);
    if (!response) throw new Error("Publication API not handled");
    return response;
  };
  const publicationSuccess = async (input: unknown): Promise<PublicationAdminResponse> => {
    const response = await call(input);
    if (response.status !== 200) throw new Error(`Publication API failed with HTTP ${response.status}`);
    return publicationAdminResponseSchema.parse(await response.json<unknown>());
  };
  const purges: LifecyclePurgeTarget[] = [];
  const cachedAssets: M6CachedLoopback = Object.assign(() => ({ fetch: async () => new Response() }), {
    invalidate: async (target: LifecyclePurgeTarget) => { purges.push(target); }, ...setup.bindings.cachedAssets,
  });
  const candidateEnv: M6CandidateEnv = { ...env, CASTLOOP_BUCKET: setup.bucket as never,
    CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" },
    CASTLOOP_DLQ_NAME: setup.config.dlq_name, CASTLOOP_QUEUE: { send: async () => {} } as never };
  const markerKey = mode === "show" ? `staging/shows/daily/${publicationOperation.job_id}/commit.json` :
    `staging/episodes/daily/next/${publicationOperation.job_id}/commit.json`;
  return { ...setup, env, sent, base, stages, frozen, publicationOperation, body, http, call, publicationSuccess, markerKey, candidateEnv, cachedAssets, purges };
}
