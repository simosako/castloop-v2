import { parseEpisodeLifecycle, parseEpisodeRevision, parseShowControl, showReservationSchema,
  targetInspectionRequestSchema, targetInspectionResponseSchema } from "@castloop/shared";
import type { ServiceConfig, TargetInspectionRequest, TargetInspectionResponse } from "@castloop/shared";
import { ManagementR2Reader, readManagementRuntime } from "./management-r2";
import type { ManagementReader } from "./management-r2";

export class ManagementTargetInspection {
  constructor(private readonly config: ServiceConfig, private readonly reader: ManagementReader = new ManagementR2Reader(config)) {}
  async inspect(input: TargetInspectionRequest): Promise<TargetInspectionResponse> {
    const request = targetInspectionRequestSchema.parse(input);
    if (request.service_id !== this.config.service_id) throw new Error("Target inspection belongs to another service");
    const runtime = await readManagementRuntime(this.reader, this.config);
    const showKey = `system/show-publications/${request.show_id}.json`;
    const episodeKey = request.kind === "episode" ? `system/episode-lifecycle/${request.show_id}/${request.episode_id}.toml` : undefined;
    const observed = new Map<string, Awaited<ReturnType<ManagementReader["read"]>>>();
    const read = async (key: string, maximum = 16384) => {
      const object = await this.reader.read(key, maximum);
      observed.set(key, object);
      return object;
    };
    const showObject = await read(showKey);
    const show = showObject ? parseShowControl(JSON.parse(showObject.source)) : null;
    if (show && show.show_id !== request.show_id) throw new Error("Show control differs from its key");
    const reservation = await read(`system/show-reservations/${request.show_id}.json`);
    if (reservation) {
      const value = showReservationSchema.parse(JSON.parse(reservation.source));
      if (!show || value.show_id !== request.show_id || value.reservation_id !== show.reservation_id) throw new Error("Show registration is incomplete");
    } else if (show?.reservation_id) throw new Error("Show registration is incomplete");
    const episodeObject = episodeKey ? await read(episodeKey) : null;
    const episode = episodeObject ? parseEpisodeLifecycle(episodeObject.source) : null;
    if (episode && (!show || episode.show_id !== request.show_id || episode.episode_id !== request.episode_id)) throw new Error("Episode control differs from its Show/key");
    let currentRevision: TargetInspectionResponse["current_revision"] = null;
    if (episodeKey && !show?.owner) {
      const metadataKey = `public/episodes/${request.show_id}/${request.episode_id}/metadata.toml`;
      const metadata = await read(metadataKey, 1_000_000);
      if (episode && ["active", "unpublished"].includes(episode.lifecycle)) {
        if (!metadata) throw new Error("Current Episode metadata is missing");
        currentRevision = parseEpisodeRevision(metadata.source);
        if (currentRevision.episode_id !== request.episode_id) throw new Error("Current revision differs from its Episode");
        const history = await read(`public/episodes/${request.show_id}/${request.episode_id}/revisions/${currentRevision.revision_id}.toml`, 1_000_000);
        if (!history || JSON.stringify(parseEpisodeRevision(history.source)) !== JSON.stringify(currentRevision)) throw new Error("Current Episode history is inconsistent");
      } else if ((!episode || episode.lifecycle === "draft") && metadata) throw new Error("Draft Episode has orphan metadata");
    }
    for (const [key, before] of observed) {
      const after = await this.reader.read(key, key.startsWith("public/") ? 1_000_000 : 16384);
      if (before?.etag !== after?.etag || before?.source !== after?.source) throw new Error("Target changed during the read-only R2 snapshot");
    }
    const afterRuntime = await readManagementRuntime(this.reader, this.config);
    if (runtime.workerVersionId !== afterRuntime.workerVersionId || runtime.admissionWindowId !== afterRuntime.admissionWindowId ||
      runtime.admission.state !== afterRuntime.admission.state) throw new Error("Runtime window changed during target inspection");
    return targetInspectionResponseSchema.parse({ schema_version: 1, result: "target", request, snapshot_only: true,
      authorizes_operation: false, payloads_verified: false, admission_state: runtime.admission.state,
      show: show ? { lifecycle: show.lifecycle, generation: show.generation } : null,
      episode: episode ? { lifecycle: episode.lifecycle, generation: episode.generation } : null,
      unfinished_show_operation: !!show?.owner, current_revision: currentRevision });
  }
}
