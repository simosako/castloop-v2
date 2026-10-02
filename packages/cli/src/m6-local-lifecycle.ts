import { z } from "zod";
import { lifecycleAdminRequestSchema, lifecycleAdminResponseSchema, lifecycleOperationRequestSchema, serviceConfigSchema,
  targetInspectionRequestSchema, targetInspectionResponseSchema } from "@castloop/shared";
import type { LifecycleAdminRequest, LifecycleAdminResponse, LifecycleOperationRequest, ServiceConfig } from "@castloop/shared";
import { LifecycleAdminClient } from "./lifecycle-client";
import { createLifecycleJournal, readLocalLifecycleJob } from "./lifecycle-journal";
import type { LifecycleClientState, LifecycleJournal } from "./lifecycle-journal";
import { createLifecycleOperationEffects, runLifecycleClaim, runLifecycleCommit } from "./lifecycle-operation";
import type { LocalDraftTarget } from "./local-draft-journal";
import { TargetInspectionClient } from "./target-inspection-client";
import { createHash } from "node:crypto";

type Preview = Extract<LifecycleAdminResponse, { result: "preview" }>;
type Confirmation = Extract<LifecycleAdminRequest, { action: "claim" }>["confirmation"];
export type M6LifecyclePlan = { request: LifecycleOperationRequest; preview: Preview };
export type M6LifecyclePlanningOptions = { inspector?: Pick<TargetInspectionClient, "inspect">;
  client?: Pick<LifecycleAdminClient, "dryRun">; now?: () => Date };
const planSchema = z.object({ request: lifecycleOperationRequestSchema, preview: lifecycleAdminResponseSchema }).strict();

function requestHash(request: LifecycleOperationRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function validateM6LifecyclePlan(configInput: ServiceConfig, input: unknown): M6LifecyclePlan {
  const config = serviceConfigSchema.parse(configInput);
  const plan = planSchema.parse(input);
  if (plan.preview.result !== "preview" || plan.preview.service_id !== config.service_id ||
    JSON.stringify(plan.preview.request) !== JSON.stringify(plan.request) || plan.preview.request_sha256 !== requestHash(plan.request)) {
    throw new Error("Lifecycle plan preview differs from its exact service and canonical frozen request");
  }
  return { request: plan.request, preview: plan.preview };
}

export async function previewLocalM6Lifecycle(configInput: ServiceConfig, target: LocalDraftTarget,
  action: LifecycleOperationRequest["action"], adminKey: string, options: M6LifecyclePlanningOptions = {}): Promise<M6LifecyclePlan> {
  const config = serviceConfigSchema.parse(configInput);
  const inspectionRequest = targetInspectionRequestSchema.parse({ schema_version: 1, service_id: config.service_id, ...target });
  lifecycleOperationRequestSchema.shape.action.parse(action);
  const inspector = options.inspector ?? new TargetInspectionClient(config, adminKey);
  const snapshot = targetInspectionResponseSchema.parse(await inspector.inspect(inspectionRequest));
  if (JSON.stringify(snapshot.request) !== JSON.stringify(inspectionRequest)) throw new Error("Lifecycle inspection targets another exact service or content identity");
  const request = lifecycleOperationRequestSchema.parse({ schema_version: 1, job_id: crypto.randomUUID(), ...target, action,
    expected_show_generation: snapshot.show?.generation ?? 0, created_at: (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(target.kind === "episode" ? { expected_episode_generation: snapshot.episode?.generation ?? 0 } : {}) });
  const client = options.client ?? new LifecycleAdminClient(config, adminKey);
  const preview = await client.dryRun({ schema_version: 1, service_id: config.service_id, action: "dry-run", request });
  return validateM6LifecyclePlan(config, { request, preview });
}

export function prepareLocalM6Lifecycle(root: string, configInput: ServiceConfig, planInput: M6LifecyclePlan,
  confirmation: Confirmation): LifecycleJournal {
  const config = serviceConfigSchema.parse(configInput);
  const plan = validateM6LifecyclePlan(config, planInput);
  if (!plan.preview.eligible) throw new Error("Lifecycle preview has blockers; do not turn it into an operation request");
  const claim = lifecycleAdminRequestSchema.parse({ schema_version: 1, service_id: config.service_id, action: "claim", request: plan.request, confirmation });
  if (claim.action !== "claim") throw new Error("Lifecycle preparation requires an explicit confirmed claim");
  const before = readLocalLifecycleJob(root, config, claim.request.job_id);
  if (before.lock_present || before.client_state && before.client_state.phase !== "prepared") {
    throw new Error("Preserve a requested lifecycle outcome or retained lock; never replay it from preview observations");
  }
  const journal = createLifecycleJournal(root, config, claim);
  if (readLocalLifecycleJob(root, config, claim.request.job_id).lock_present || journal.load().phase !== "prepared") {
    throw new Error("Local lifecycle journal changed during preparation");
  }
  return journal;
}

export async function executeLocalM6Lifecycle(root: string, config: ServiceConfig, plan: M6LifecyclePlan, confirmation: Confirmation,
  adminKey: string, client?: Pick<LifecycleAdminClient, "claim" | "commit" | "retry" | "status">): Promise<LifecycleClientState> {
  const journal = prepareLocalM6Lifecycle(root, config, plan, confirmation);
  const effects = createLifecycleOperationEffects(config, journal.load(), adminKey, client);
  await runLifecycleClaim(journal, effects);
  await runLifecycleCommit(journal, effects);
  return journal.load();
}
