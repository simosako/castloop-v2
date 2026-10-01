import { lifecycleAdminRequestSchema, lifecycleAdminResponseSchema, lifecycleCommitKey, lifecycleCommitSchema } from "../packages/shared/src/index";
import type { LifecycleAdminRequest, LifecycleAdminResponse } from "../packages/shared/src/index";
import { readBoundedAdminJson } from "./admin-body";
import { authenticated } from "./admin-auth";
import { commitOwnedLifecycleOperation } from "./lifecycle-commit";
import { requeueLifecycleOperation } from "./lifecycle-consumer";
import { claimShowOperation, controlRequestHash, readEpisodeLifecycle, readShowControl, requireEligibleTarget, requireOwnedOperation } from "./lifecycle-control";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { readLifecycleDeletionPage } from "./lifecycle-deletion";
import type { DeletionReadEnv } from "./lifecycle-deletion";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import { inspectLifecycleJob } from "./lifecycle-inspection";
import { M6ManagementServiceMismatch, withM6ManagementInvocation, withM6ManagementRead } from "./m6-management";

export type LifecycleAdminEnv = LifecycleControlEnv & DeletionReadEnv & { CASTLOOP_ADMIN_KEY: string; CASTLOOP_QUEUE: Pick<Queue, "send"> };
type PreviewInput = Extract<LifecycleAdminRequest, { action: "dry-run" }>;
type Preview = Extract<LifecycleAdminResponse, { result: "preview" }>;

function reply(input: object, status = 200): Response {
  return Response.json(input, { status, headers: { "Cache-Control": "no-store" } });
}

async function previewLifecycle(env: LifecycleAdminEnv, bindings: M6DeliveryGateBindings, input: PreviewInput, hash: string): Promise<Preview> {
  return withM6ManagementRead(env, input.service_id, bindings, async (admission) => {
    const request = input.request;
    const show = await readShowControl(env, request.show_id);
    const episode = request.kind === "episode" ? await readEpisodeLifecycle(env, request.show_id, request.episode_id!) : null;
    const blockers: Preview["blockers"] = [];
    if (admission.state === "paused") blockers.push("service_paused");
    if (admission.invocations.length === 32) blockers.push("service_registry_full");
    if (!show || request.kind === "episode" && !episode) blockers.push("target_missing");
    if (show?.value.owner) blockers.push("unfinished_show_operation");
    if (show && !show.value.owner && (request.kind === "show" || episode)) {
      try { await requireEligibleTarget(env, show.value, request); }
      catch { blockers.push("target_not_eligible"); }
    }
    if (await env.CASTLOOP_BUCKET.head(`system/jobs/${request.job_id}/status.toml`)) blockers.push("job_id_used");
    let deletionPage: Preview["deletion_page"];
    if (request.action === "delete" && show && (request.kind === "show" || episode)) {
      const scopeIndex = input.scope_index ?? 0;
      const page = await readLifecycleDeletionPage(env, request.kind === "show" ? { kind: "show", showId: request.show_id } :
        { kind: "episode", showId: request.show_id, episodeId: request.episode_id! },
      { scopeIndex, cursor: input.cursor, limit: input.maximum_objects ?? 100 });
      const payloadBytes = page.payload.reduce((sum, object) => sum + object.size, 0);
      if (!Number.isSafeInteger(payloadBytes)) throw new Error("Deletion preview exceeds its byte-count budget");
      if (page.blockers.length) blockers.push("unknown_payload_key");
      deletionPage = { scope_index: scopeIndex, payload_objects: page.payload.length, payload_bytes: payloadBytes,
        retained_marker_objects: page.retainedMarkers.length, unknown_objects: page.blockers.length, scope_complete: page.scopeComplete,
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}), authorizes_deletion: false, retains_operational_records: true };
    }
    const currentShow = await readShowControl(env, request.show_id);
    const currentEpisode = request.kind === "episode" ? await readEpisodeLifecycle(env, request.show_id, request.episode_id!) : null;
    if (show?.etag !== currentShow?.etag || JSON.stringify(show?.value) !== JSON.stringify(currentShow?.value) ||
      JSON.stringify(episode) !== JSON.stringify(currentEpisode)) throw new Error("Lifecycle target changed during its preview");
    const preview = lifecycleAdminResponseSchema.parse({ schema_version: 1, service_id: input.service_id, result: "preview", request,
      request_sha256: hash, snapshot_only: true, authorizes_operation: false, payloads_verified: false, eligible: blockers.length === 0,
      admission_state: admission.state, show: show ? { lifecycle: show.value.lifecycle, generation: show.value.generation } : null,
      episode: episode ? { lifecycle: episode.lifecycle, generation: episode.generation } : null, blockers,
      ...(deletionPage ? { deletion_page: deletionPage } : {}) });
    if (preview.result !== "preview") throw new Error("Invalid lifecycle preview response");
    return preview;
  });
}

export async function handleM6LifecycleAdmin(request: Request, env: LifecycleAdminEnv, bindings: M6DeliveryGateBindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/lifecycle") return null;
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
  let input: LifecycleAdminRequest;
  try { input = lifecycleAdminRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ error: "Invalid lifecycle input", reason_code: "lifecycle_input_invalid" }, 400); }
  try {
    const hash = await controlRequestHash(input.request);
    if (input.action === "dry-run") return reply(await previewLifecycle(env, bindings, input, hash));
    const expected = lifecycleCommitSchema.parse({ schema_version: 1, job_id: input.request.job_id, show_id: input.request.show_id,
      kind: input.request.kind, ...(input.request.episode_id ? { episode_id: input.request.episode_id } : {}), action: input.request.action,
      show_generation: input.request.expected_show_generation + 1, request_sha256: hash });
    if (input.action === "status") {
      return reply(await withM6ManagementRead(env, input.service_id, bindings, () => inspectLifecycleJob(env, input.service_id, expected)));
    }
    if (input.confirmation.request_sha256 !== hash) return reply({ error: "Confirmation differs from the frozen request", reason_code: "lifecycle_input_invalid" }, 400);
    const target = { showId: input.request.show_id, ...(input.request.episode_id ? { episodeId: input.request.episode_id } : {}) };
    const result = await withM6ManagementInvocation(env, input.service_id, input.action === "claim" ? "m6_admin" : "m6_recovery", target, bindings,
      async (): Promise<LifecycleAdminResponse> => {
        const frozen = input.request;
        if (input.action === "claim") {
          await claimShowOperation(env, frozen);
          return lifecycleAdminResponseSchema.parse({ schema_version: 1, service_id: input.service_id, result: "claimed", operation: expected });
        }
        const operation = { showId: frozen.show_id, jobId: frozen.job_id, generation: expected.show_generation };
        const current = await requireOwnedOperation(env, operation.showId, operation.jobId, operation.generation);
        if (current.value.owner.request_sha256 !== hash) throw new Error("Lifecycle commit input differs from its frozen owner");
        if (input.action === "retry") {
          const key = lifecycleCommitKey({ kind: expected.kind, show_id: expected.show_id, job_id: expected.job_id,
            ...(expected.episode_id ? { episode_id: expected.episode_id } : {}) });
          await requeueLifecycleOperation(env, expected, async (queuedKey) => {
            if (queuedKey !== key) throw new Error("Lifecycle retry targets another commit marker");
            await env.CASTLOOP_QUEUE.send({ object: { key } });
          });
          return lifecycleAdminResponseSchema.parse({ schema_version: 1, service_id: input.service_id, result: "requeued", operation: expected, key });
        }
        const committed = await commitOwnedLifecycleOperation(env, operation);
        if (JSON.stringify(committed.marker) !== JSON.stringify(expected)) throw new Error("Lifecycle commit differs from its confirmed request");
        return lifecycleAdminResponseSchema.parse({ schema_version: 1, service_id: input.service_id, result: "committed",
          operation: committed.marker, key: committed.key, created: committed.created });
      });
    return reply(result);
  } catch (error) {
    if (error instanceof M6ManagementServiceMismatch) return reply({ error: "Service ID mismatch", reason_code: "lifecycle_input_invalid" }, 400);
    console.error(JSON.stringify({ event: "lifecycle_operation_blocked", reason_code: "lifecycle_operation_blocked" }));
    return reply({ error: "Lifecycle operation blocked; inspect retained ownership and progress", reason_code: "lifecycle_operation_blocked" }, 409);
  }
}
