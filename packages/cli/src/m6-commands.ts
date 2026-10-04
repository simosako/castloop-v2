import {
  buildM6WorkerUploadMetadata, lifecycleOperationRequestSchema, m6ServiceConfigHash,
  m6ServiceUpdateRequestSchema, showMetadataSchema, validateId,
} from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { administratorKey } from "./administrator-key";
import { CloudflareApi } from "./cloudflare-api";
import { ContentListClient } from "./content-list";
import { readBoundedLocalJournal } from "./local-journal-read";
import { createLifecycleJournal, readLocalLifecycleJob } from "./lifecycle-journal";
import { createLifecycleOperationEffects, runLifecycleRetry } from "./lifecycle-operation";
import { createFreshM6RestEffects } from "./m6-initialization-rest";
import { createM6LocalEpisodeDraft, createM6LocalShowDraft } from "./m6-local-drafts";
import { confirmLocalM6Lifecycle, executeLocalM6Lifecycle, previewLocalM6Lifecycle, validateM6LifecyclePlan } from "./m6-local-lifecycle";
import { publishLocalM6Draft, updateLocalM6Draft } from "./m6-local-update";
import { M6ServiceClient } from "./m6-service-client";
import { createFreshM6InitializationJournal, openFreshM6InitializationJournal, reconcileFreshM6Initialization, runFreshM6Initialization } from "./m6-service-initialization";
import { createM6UpdateJournal, readLocalM6Update, reconcileM6UpdateCompletion, resumeM6UpdateCompletion, resumeM6UpdateDeploymentVerification, runM6Update } from "./m6-service-update";
import type { M6UpdateJournal } from "./m6-service-update";
import { M6SetupClient } from "./m6-setup-client";
import { M6UpdateClient } from "./m6-update-client";
import { createM6UpdateRestEffects } from "./m6-update-rest";
import { createPublicationJournal, readLocalPublicationJob } from "./publication-journal";
import { createPublicationOperationEffects, runPublicationRetry } from "./publication-operation";
import { readRemoteOperationStatus } from "./remote-operation-status";
import { createShowRegistrationJournal } from "./show-registration-journal";
import { createShowRegistrationEffects, runShowRegistration } from "./show-registration-operation";
import { TargetInspectionClient } from "./target-inspection-client";
import { WORKER_COMPATIBILITY_DATE } from "./worker-payload";
import { workerPayloadHash } from "./worker-upload-hash";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export const M6_COMMAND_ARGUMENTS: Record<string, number> = {
  init: 1, "init-reconcile": 1, "update-service": 1, "update-service-verify": 1, "update-service-reconcile": 1,
  "service-status": 0, "service-pause": 1, "service-resume": 1, "target-show": 1, "target-episode": 2,
  "list-shows": 0, "list-episodes": 1,
  "preview-show-lifecycle": 2, "preview-episode-lifecycle": 3, "lifecycle-execute": 3, "lifecycle-retry": 3,
  "publication-retry": 1, "operation-status": 2, "create-show": 2, "create-episode": 2,
  "update-show": 1, "update-episode": 2, "update-episode-audio": 3, "publish-show": 1, "publish-episode": 3,
};

export async function runM6Command(root: string, config: ServiceConfig, command: string, args: string[], options: {
  workerSource: () => Promise<string>;
  updateClient?: (api: CloudflareApi, key: string) => M6UpdateClient;
  listOptions?: { cursor?: string; includeDeleted?: boolean };
}): Promise<unknown> {
  const count = command === "publish-episode" && args.length === 2 ? 2 : M6_COMMAND_ARGUMENTS[command];
  if (!Object.hasOwn(M6_COMMAND_ARGUMENTS, command) || args.length !== count || args.some((arg) => !arg || arg.startsWith("--"))) {
    throw new Error("Invalid command arguments; use --help");
  }
  if (!lstatSync(root).isDirectory()) throw new Error("Workspace must be a real directory");
  const key = administratorKey(root, command === "init");
  if (command === "list-shows" || command === "list-episodes") {
    const target = command === "list-shows" ? { kind: "show" as const } : { kind: "episode" as const, show_id: validateId(args[0]!, "show") };
    return new ContentListClient(config, key).list({ schema_version: 1, service_id: config.service_id,
      include_deleted: options.listOptions?.includeDeleted ?? false, ...target,
      ...(options.listOptions?.cursor === undefined ? {} : { cursor: options.listOptions.cursor }) });
  }
  if (command === "publication-retry") {
    const retained = readLocalPublicationJob(root, config, args[0]!);
    if (!retained.client_state || retained.lock_present) throw new Error("Retry requires its retained publication journal without an unknown lock");
    const journal = createPublicationJournal(root, config, retained.client_state.publication);
    await runPublicationRetry(journal, createPublicationOperationEffects(config, journal.load(), key));
    return { result: "publication-requeued", job_id: args[0] };
  }
  if (command === "operation-status") return readRemoteOperationStatus(root, config, args[0]!, args[1]!, () => key);
  if (command === "lifecycle-execute") {
    const plan = validateM6LifecyclePlan(config, readBoundedLocalJournal(resolve(args[0]!)));
    const confirmation = confirmLocalM6Lifecycle(plan.request.action, args[1]!, args[2]!);
    const state = await executeLocalM6Lifecycle(root, config, plan, confirmation, key);
    return { result: "lifecycle-committed", job_id: state.claim.request.job_id };
  }
  if (command === "lifecycle-retry") {
    const retained = readLocalLifecycleJob(root, config, args[0]!);
    if (!retained.client_state || retained.lock_present) throw new Error("Retry requires its retained confirmed journal without an unknown lock");
    const claim = retained.client_state.claim;
    const journal = createLifecycleJournal(root, config, { ...claim, confirmation: confirmLocalM6Lifecycle(claim.request.action, args[1]!, args[2]!) });
    await runLifecycleRetry(journal, createLifecycleOperationEffects(config, journal.load(), key));
    return { result: "lifecycle-requeued", job_id: claim.request.job_id };
  }
  if (command.startsWith("preview-")) {
    const showId = validateId(args[0]!, "show");
    const episode = command === "preview-episode-lifecycle";
    const target = episode ? { kind: "episode" as const, show_id: showId, episode_id: validateId(args[1]!, "episode") } : { kind: "show" as const, show_id: showId };
    const action = lifecycleOperationRequestSchema.shape.action.parse(args[episode ? 2 : 1]);
    return previewLocalM6Lifecycle(config, target, action, key);
  }
  if (command === "init") {
    const source = await options.workerSource();
    const metadata = buildM6WorkerUploadMetadata(config, null, key, WORKER_COMPATIBILITY_DATE);
    const journal = await createFreshM6InitializationJournal(root, config, args[0]!, source, metadata);
    await runFreshM6Initialization(journal, createFreshM6RestEffects(new CloudflareApi(config), key), source, metadata);
    return { result: "initialized-paused", operation_id: args[0], runtime_readiness: journal.load().runtime_readiness };
  }
  if (command === "init-reconcile") {
    const journal = await openFreshM6InitializationJournal(root, config);
    if (journal.load().request.operation_id !== args[0]) throw new Error("Initialization reconciliation has another operation identity");
    const client = new M6SetupClient(config, key, new CloudflareApi(config));
    await reconcileFreshM6Initialization(journal, (_config, target) => client.observeCompleted({ target }));
    return { result: "initialized-paused", operation_id: args[0], runtime_readiness: journal.load().runtime_readiness };
  }
  if (command.startsWith("update-service")) {
    const operationId = m6ServiceUpdateRequestSchema.shape.operation_id.parse(args[0]);
    const api = new CloudflareApi(config);
    const client = options.updateClient ? options.updateClient(api, key) : new M6UpdateClient(config, key, api);
    const effects = createM6UpdateRestEffects(api, { begin: (input) => client.begin(input),
      admission: () => client.admission(), complete: (input, target) => client.complete(input, target) });
    let journal: M6UpdateJournal;
    if (command !== "update-service") {
      const retained = readLocalM6Update(root, config, operationId);
      if (!retained.state || retained.lockPresent) throw new Error("Verification requires its retained journal without an unknown lock");
      journal = await createM6UpdateJournal(root, config, retained.state.request);
      if (command === "update-service-reconcile") await reconcileM6UpdateCompletion(journal, (request, target) => client.observeCompleted(request, target));
      else if (retained.state.phase === "deploy_requested") await resumeM6UpdateDeploymentVerification(journal, effects);
      else await resumeM6UpdateCompletion(journal, effects);
    } else {
      const source = await options.workerSource();
      const status = await new M6ServiceClient(config, key).call({ service_id: config.service_id, action: "status" });
      if (status.admission.state !== "paused" || status.admission.invocations.length) throw new Error("Explicitly pause and drain before a compatible update");
      const metadata = await api.prepareCompatibleM6WorkerUpload(config, status.worker_version_id);
      const request = m6ServiceUpdateRequestSchema.parse({ operation_id: operationId, service_id: config.service_id,
        pause_id: status.admission.pause_id, expected_service_generation: status.admission.generation,
        previous_worker_version_id: status.worker_version_id, service_config_sha256: await m6ServiceConfigHash(config),
        worker_source_sha256: workerPayloadHash(source), worker_metadata_sha256: workerPayloadHash(metadata) });
      journal = await createM6UpdateJournal(root, config, request);
      await runM6Update(journal, effects, source, metadata);
    }
    return { result: "updated-paused", operation_id: operationId, runtime_readiness: journal.load().runtime_readiness };
  }
  if (command.startsWith("service-")) {
    const action = command.slice("service-".length) as "status" | "pause" | "resume";
    return new M6ServiceClient(config, key).call(action === "status" ? { service_id: config.service_id, action } : { service_id: config.service_id, action, pause_id: args[0]! });
  }
  const showId = validateId(args[0]!, "show");
  if (command.startsWith("target-")) {
    const target = command === "target-show" ? { kind: "show" as const, show_id: showId } :
      { kind: "episode" as const, show_id: showId, episode_id: validateId(args[1]!, "episode") };
    return new TargetInspectionClient(config, key).inspect({ schema_version: 1, service_id: config.service_id, ...target });
  }
  if (command === "create-show") {
    showMetadataSchema.shape.site_url.parse(args[1]);
    if (existsSync(join(root, showId))) throw new Error("Local Show directory already exists; do not create another registration");
    const journal = createShowRegistrationJournal(root, config, { schema_version: 1, action: "reserve", service_id: config.service_id,
      show_id: showId, reservation_id: crypto.randomUUID() });
    await runShowRegistration(journal, createShowRegistrationEffects(config, key));
    return createM6LocalShowDraft(root, config, showId, args[1]!);
  }
  const episodeId = command.endsWith("show") ? undefined : validateId(args[1]!, "episode");
  if (command === "create-episode") return createM6LocalEpisodeDraft(root, config, showId, episodeId!);
  const target = episodeId ? { kind: "episode" as const, show_id: showId, episode_id: episodeId } : { kind: "show" as const, show_id: showId };
  if (command.startsWith("publish-")) {
    const state = await publishLocalM6Draft(root, config, target, key, args[2] ? { audioPath: resolve(args[2]) } : {});
    return { result: "publication-committed", job_id: state.publication.request.job_id };
  }
  const state = await updateLocalM6Draft(root, config, target, command === "update-show" ? { asset: "show" } : command === "update-episode" ?
    { asset: "episode_metadata" } : { asset: "audio", audio_path: resolve(args[2]!) }, key, {
      rest: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" },
    });
  if (state.finish_receipt !== "staged") throw new Error("Staging was explicitly aborted; its receipt was retained and publication was not authorized");
  return { result: "staged", operation_id: state.upload.operation_id };
}
