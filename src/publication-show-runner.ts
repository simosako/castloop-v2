import { lifecycleFailureForPhase, lifecycleJobStatusSchema, lifecycleProgressSchema, parseServiceConfig,
  parseShowControl, parseShowMetadata } from "../packages/shared/src/index";
import type { LifecycleProgress } from "../packages/shared/src/index";
import { putPublicDeliveryRecord } from "./public-delivery-records";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";
import { advanceLifecycleFeedGeneration } from "./lifecycle-mutations";
import { publicationCommitKey, readFrozenPublicationCommit, requireOwnedPublication, verifyPublicationStaging } from "./publication-admission";
import { publicationChecksum, readPublicationBytes, renderPublicationFeed } from "./publication-inputs";
import type { PublicationEffects } from "./publication-inputs";
import { measureWorkerPhase } from "./worker-timing";
import { parsePublicationInput, PublicationValidationFailure } from "./publication-validation";

export type ShowPublicationEffects = PublicationEffects;

export async function runOwnedShowPublication(env: LifecycleFeedEnv, execution: ShowExecution,
  effects: ShowPublicationEffects): Promise<void | "failed"> {
  const existing = await measureWorkerPhase(execution.jobId, "publication.runner_control", () => readShowControl(env, execution.showId));
  const receipt = existing?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation && receipt.execution_id === execution.executionId) {
    await measureWorkerPhase(execution.jobId, "publication.owner_release", () => finishShowOperation(env, execution));
    return;
  }
  const owned = await measureWorkerPhase(execution.jobId, "publication.runner_manifest", () => requireOwnedPublication(env, execution));
  if (owned.frozen.commit.kind !== "show") throw new Error("Show publication requires a Show commit");
  const marker = await measureWorkerPhase(execution.jobId, "publication.frozen_commit", () =>
    readFrozenPublicationCommit(env, publicationCommitKey(owned.frozen.commit)));
  if (!marker || JSON.stringify(marker) !== JSON.stringify(owned.frozen)) throw new Error("Show publication has no matching frozen commit");
  const commit = owned.frozen.commit;
  const journal = await measureWorkerPhase(execution.jobId, "publication.journal_read", () => readLifecycleJobJournal(env, execution));
  if (journal.status?.state === "failed") return "failed";
  const canRejectInputs = !journal.progress || ["admitted", "validating"].includes(journal.progress.phase);
  let progress = journal.progress ?? lifecycleProgressSchema.parse({ schema_version: 1, ...journal.identity, phase: "admitted",
    deleted_objects: 0, purge_confirmed: false, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  if (journal.status?.state === "published") {
    await measureWorkerPhase(execution.jobId, "publication.owner_release", () => finishShowOperation(env, execution));
    return;
  }
  if (journal.status?.state === "completed" || journal.status?.state === "abandoned") throw new Error("Show publication status is incompatible");
  if (!["admitted", "validating", "feed", "purge", "visibility", "finished"].includes(progress.phase) ||
    progress.purge_confirmed !== ["visibility", "finished"].includes(progress.phase)) throw new Error("Show publication progress is incompatible");
  const target = { showId: execution.showId };
  let failurePhase = progress.phase;
  async function guard(): Promise<void> {
    await measureWorkerPhase(execution.jobId, "publication.guard", async () => {
      await measureWorkerPhase(execution.jobId, "publication.guard_owner", async () => {
        await requireShowExecution(env, execution);
        await requireOwnedPublication(env, execution);
      });
      await measureWorkerPhase(execution.jobId, "publication.guard_delivery", () => effects.checkDeliveryGate(target));
      await measureWorkerPhase(execution.jobId, "publication.guard_recheck", () => requireShowExecution(env, execution));
    });
  }
  async function recordProgress(phase: LifecycleProgress["phase"], purged = false): Promise<void> {
    const next = lifecycleProgressSchema.parse({ ...progress, phase, purge_confirmed: purged,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await measureWorkerPhase(execution.jobId, `publication.progress.${phase}`, () => writeLifecycleProgress(env, execution, next));
    progress = next;
  }
  async function recordStatus(state: "processing" | "retrying" | "failed" | "published"): Promise<void> {
    await measureWorkerPhase(execution.jobId, `publication.status_write.${state}`, () => writeLifecycleJobStatus(env, execution, lifecycleJobStatusSchema.parse({ schema_version: 2, ...journal.identity,
      state, phase: progress.phase, ...(state === "published" ? { result_lifecycle: "active" } : {}),
      ...(state === "retrying" || state === "failed" ? lifecycleFailureForPhase(failurePhase) : {}) })));
  }
  async function overwrite(key: string, value: string | Uint8Array, contentType?: string): Promise<void> {
    await guard();
    const previous = await env.CASTLOOP_BUCKET.head(key);
    await requireShowExecution(env, execution);
    const written = await env.CASTLOOP_BUCKET.put(key, value, {
      onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
      ...(contentType ? { httpMetadata: { contentType } } : {}),
    });
    if (!written) throw new Error("Show publication output changed before writing");
    await requireShowExecution(env, execution);
  }
  try {
    await guard();
    if (["admitted", "validating", "feed"].includes(progress.phase)) {
      failurePhase = "validating";
      if (progress.phase !== "feed") await recordProgress("validating");
      await recordStatus("processing");
      await measureWorkerPhase(execution.jobId, "publication.verify_staging", () => verifyPublicationStaging(env, execution));
      const prefix = `staging/shows/${execution.showId}/${execution.jobId}`;
      const metadata = await readPublicationBytes(env, `${prefix}/show.toml`, 1_000_000);
      const cover = await readPublicationBytes(env, `${prefix}/cover.${commit.cover_extension}`, 5_000_000);
      if (await publicationChecksum(metadata) !== commit.metadata_sha256 || await publicationChecksum(cover) !== commit.cover_sha256) {
        throw new PublicationValidationFailure();
      }
      const source = parsePublicationInput(() => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(metadata));
      const show = parsePublicationInput(() => parseShowMetadata(source));
      const extension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
      if (show.show_id !== execution.showId || extension !== commit.cover_extension) throw new PublicationValidationFailure();
      const validCover = extension === "jpg" ? cover.length >= 3 && cover[0] === 255 && cover[1] === 216 && cover[2] === 255 :
        cover.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => cover[index] === byte);
      if (!validCover) throw new PublicationValidationFailure();
      const showKey = `system/shows/${execution.showId}/show.toml`;
      const current = await env.CASTLOOP_BUCKET.head(showKey);
      const control = await requireShowExecution(env, execution);
      if (!current && control.value.lifecycle === "active") throw new Error("Active Show has no published metadata");
      if (current) {
        const previous = parseShowMetadata(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readPublicationBytes(env, showKey, 1_000_000)));
        if (previous.show_id !== show.show_id || (previous.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") !== extension) {
          throw new Error("Show publication cannot change the published cover extension");
        }
      }
      const service = parseServiceConfig(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readPublicationBytes(env, "system/service.toml", 16384)));
      const inputs = await measureWorkerPhase(execution.jobId, "publication.feed_inputs", () => readLifecycleFeedInputs(env, execution));
      if (!inputs.writeFeed) throw new Error("Show lifecycle does not permit publication feed writing");
      const feed = renderPublicationFeed(show, inputs.episodes, service.public_base_url, extension);
      failurePhase = "feed";
      await recordProgress("feed");
      await measureWorkerPhase(execution.jobId, "publication.metadata_write", () => overwrite(showKey, source));
      await measureWorkerPhase(execution.jobId, "publication.cover_write", () =>
        overwrite(`public/podcasts/${execution.showId}/cover.${extension}`, cover, extension === "jpg" ? "image/jpeg" : "image/png"));
      await measureWorkerPhase(execution.jobId, "publication.feed_write", () =>
        overwrite(`public/podcasts/${execution.showId}/feed.xml`, feed, "application/rss+xml; charset=utf-8"));
      await measureWorkerPhase(execution.jobId, "publication.feed_generation", () => advanceLifecycleFeedGeneration(env, execution));
      await recordProgress("purge");
    }
    if (progress.phase === "purge") {
      failurePhase = "purge";
      await recordStatus("processing");
      await guard();
      await measureWorkerPhase(execution.jobId, "publication.purge", () => effects.purge(target));
      await guard();
      await recordProgress("visibility", true);
    }
    if (progress.phase === "visibility") {
      failurePhase = "visibility";
      await guard();
      await measureWorkerPhase(execution.jobId, "publication.visibility", async () => {
        const current = await requireShowExecution(env, execution);
        if (current.value.lifecycle === "draft") {
          const value = parseShowControl({ ...current.value, lifecycle: "active" });
          const written = await putPublicDeliveryRecord(env, `system/show-publications/${execution.showId}.json`, JSON.stringify(value), {
            onlyIf: { etagMatches: current.etag },
          });
          if (!written) throw new Error("Show lifecycle changed before opening publication");
        } else if (current.value.lifecycle !== "active") throw new Error("Show publication cannot restore stopped delivery");
      });
      await recordProgress("finished", true);
    }
    if (progress.phase !== "finished") throw new Error("Show publication cannot finish from its current phase");
    failurePhase = "finished";
    await recordStatus("published");
    await measureWorkerPhase(execution.jobId, "publication.owner_release", () => finishShowOperation(env, execution));
  } catch (error) {
    let rejected = false;
    await measureWorkerPhase(execution.jobId, "publication.failure_record", async () => {
      const current = await readShowControl(env, execution.showId);
      if (current?.value.last_finished_operation?.job_id === execution.jobId && current.value.last_finished_operation.generation === execution.generation &&
        current.value.last_finished_operation.execution_id === execution.executionId) return;
      const saved = await readLifecycleJobJournal(env, execution);
      if (saved.status?.state !== "published" && saved.progress?.phase !== "finished") {
        progress = saved.progress ?? progress;
        rejected = canRejectInputs && error instanceof PublicationValidationFailure &&
          ["admitted", "validating"].includes(progress.phase);
        await recordStatus(rejected ? "failed" : "retrying");
      }
    });
    if (rejected) return "failed";
    throw error;
  }
}
