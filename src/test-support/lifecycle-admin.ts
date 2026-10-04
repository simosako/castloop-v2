import { lifecycleAdminResponseSchema, lifecycleOperationRequestSchema } from "../../packages/shared/src/index";
import type { LifecycleAdminResponse, LifecycleOperationRequest } from "../../packages/shared/src/index";
import { controlRequestHash, readEpisodeLifecycle, readShowControl } from "../lifecycle-control";
import { handleM6LifecycleAdmin } from "../lifecycle-admin";
import type { LifecycleAdminEnv } from "../lifecycle-admin";
import { queueM6Candidate } from "../m6-routes";
import { parseQueueDelivery } from "../queue-delivery";
import { publicationAdminFixture } from "./publication-admin";

export async function lifecycleAdminFixture() {
  const setup = await publicationAdminFixture("episode");
  await setup.publicationSuccess(setup.body("claim"));
  await setup.publicationSuccess(setup.body("commit"));
  await queueM6Candidate({ queue: "test-queue", messages: [{ id: "publication", body: { object: { key: setup.markerKey } } }] } as never,
    setup.candidateEnv, setup.cachedAssets);
  await setup.addEpisode("untouched", "active");
  const continuations: string[] = [];
  const candidateEnv = { ...setup.candidateEnv, CASTLOOP_QUEUE: { send: async (body: unknown) => {
    const delivery = parseQueueDelivery(body);
    if (delivery?.family !== "lifecycle") throw new Error("Unexpected lifecycle continuation");
    continuations.push(delivery.key);
  } } as never };
  const env: LifecycleAdminEnv = { CASTLOOP_BUCKET: setup.bucket as never, CASTLOOP_ADMIN_KEY: "private-secret", CASTLOOP_QUEUE: candidateEnv.CASTLOOP_QUEUE };
  const operationRequest = async (kind: "show" | "episode", action: LifecycleOperationRequest["action"]): Promise<LifecycleOperationRequest> =>
    lifecycleOperationRequestSchema.parse({ schema_version: 1, show_id: "daily", job_id: crypto.randomUUID(), kind, action,
      expected_show_generation: (await readShowControl(env, "daily"))!.value.generation, created_at: "2026-10-02T12:00:00Z",
      ...(kind === "episode" ? { episode_id: "next", expected_episode_generation: (await readEpisodeLifecycle(env, "daily", "next"))!.generation } : {}),
    });
  const body = async (action: "dry-run" | "claim" | "commit" | "status" | "retry", request: LifecycleOperationRequest) => ({
    schema_version: 1, service_id: "service", action, request,
    ...(action !== "dry-run" && action !== "status" ? { confirmation: { operator_confirmed: true, request_sha256: await controlRequestHash(request),
      ...(request.action === "delete" ? { irreversible_delete_acknowledged: true, retained_records_acknowledged: true } : {}),
    } } : {}),
  });
  const http = (input: unknown, secret = "private-secret", method = "POST") => new Request("https://current.example/admin/lifecycle", {
    method, headers: { "X-Castloop-Key": secret }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  const call = async (input: unknown) => {
    const response = await handleM6LifecycleAdmin(http(input), env, setup.bindings);
    if (!response) throw new Error("Lifecycle API not handled");
    return response;
  };
  const success = async (input: unknown): Promise<LifecycleAdminResponse> => {
    const response = await call(input);
    if (response.status !== 200) throw new Error(`Lifecycle API failed with HTTP ${response.status}`);
    return lifecycleAdminResponseSchema.parse(await response.json<unknown>());
  };
  const consume = async (key: string, maximumObjects = 2) => {
    const run = async (next: string) => queueM6Candidate({ queue: "test-queue", messages: [{ id: "lifecycle", body: { object: { key: next } } }] } as never,
      candidateEnv, setup.cachedAssets, { maximumObjects });
    await run(key);
    let count = 1;
    while (continuations.length) {
      if (++count > 100) throw new Error("Lifecycle continuation did not converge");
      await run(continuations.pop()!);
    }
    return count;
  };
  const execute = async (request: LifecycleOperationRequest) => {
    await success(await body("claim", request));
    const result = await success(await body("commit", request));
    if (result.result !== "committed") throw new Error("Expected lifecycle marker");
    return { result, invocations: await consume(result.key) };
  };
  return { ...setup, env, candidateEnv, continuations, operationRequest, body, http, call, success, consume, execute };
}
