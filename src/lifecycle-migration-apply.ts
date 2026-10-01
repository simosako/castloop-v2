import { frozenMigrationPlanSchema, migrationApplyProgressSchema, migrationRuntimeProofSchema, parseEpisodeLifecycle, parseServiceConfig, parseShowControl,
  serviceAdmissionSchema, stringifyLifecycleToml } from "../packages/shared/src/index";
import type { FrozenMigrationPlan, MigrationApplyProgress, MigrationRuntimeProof } from "../packages/shared/src/index";
import { planLifecycleMigration } from "./lifecycle-migration";
import type { MigrationReadEnv } from "./lifecycle-migration";
import { acquireServiceMigrationExecution, completeServiceMigration, readServiceAdmission, releaseServiceMigrationExecution,
  requireServiceMigration, SERVICE_ADMISSION_KEY } from "./service-admission";
import type { ServiceMigrationExecution } from "./service-admission";
import type { LifecycleControlEnv } from "./lifecycle-control";

export type MigrationApplyEnv = MigrationReadEnv & LifecycleControlEnv;
export type MigrationApplyEffects = {
  checkQuiescence: (execution: ServiceMigrationExecution) => Promise<void>;
  verifyCutover: (execution: ServiceMigrationExecution) => Promise<MigrationRuntimeProof>;
};
export type MigrationApplyResult = { state: "pending" | "completed"; phase: MigrationApplyProgress["phase"] };
type Target = { key: string; mode: "initialize" | "preserve"; source: string; parse: (source: string) => unknown; value: unknown };

function managedKey(key: string): boolean {
  return key === SERVICE_ADMISSION_KEY || /^system\/lifecycle-migrations\/[a-f0-9-]{36}\/(request|plan|progress)\.json$/.test(key);
}

function targets(plan: FrozenMigrationPlan): Target[] {
  return plan.shows.flatMap((show) => [
    ...show.episodes.map((episode) => ({ key: `system/episode-lifecycle/${show.show_id}/${episode.episode_id}.toml`, mode: episode.mode,
      source: stringifyLifecycleToml(episode.value), parse: (source: string) => parseEpisodeLifecycle(source), value: episode.value })),
    { key: `system/show-publications/${show.show_id}.json`, mode: show.mode, source: JSON.stringify(show.value),
      parse: (source: string) => parseShowControl(JSON.parse(source)), value: show.value },
  ]);
}

async function hash(plan: FrozenMigrationPlan): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(plan)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readPlan(env: MigrationApplyEnv, execution: ServiceMigrationExecution): Promise<FrozenMigrationPlan | null> {
  const owner = await requireServiceMigration(env, execution);
  const object = await env.CASTLOOP_BUCKET.get(`system/lifecycle-migrations/${execution.migrationId}/plan.json`);
  if (!object) return null;
  if (object.size < 1 || object.size > 8_000_000) throw new Error("Frozen migration plan is oversized or empty");
  const plan = frozenMigrationPlanSchema.parse(await object.json<unknown>());
  if (plan.service_id !== execution.serviceId || plan.migration_id !== execution.migrationId ||
    plan.request_sha256 !== owner.value.migration!.request_sha256) throw new Error("Frozen migration plan does not match its service owner");
  return plan;
}

async function freezePlan(env: MigrationApplyEnv, execution: ServiceMigrationExecution): Promise<FrozenMigrationPlan> {
  const existing = await readPlan(env, execution);
  if (existing) return existing;
  const inventory = await planLifecycleMigration(env);
  if (!inventory.inventory_compatible) throw new Error("Migration inventory has unresolved blockers; do not initialize any controls");
  const sourceService = inventory.sources.find((source) => source.key === "system/service.toml");
  const service = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!sourceService || !service || service.size > 16384 || service.etag !== sourceService.etag || service.size !== sourceService.size ||
    parseServiceConfig(await service.text()).service_id !== execution.serviceId) throw new Error("Migration service configuration does not match its admission");
  const owner = await requireServiceMigration(env, execution);
  const plan = frozenMigrationPlanSchema.parse({ schema_version: 1, service_id: execution.serviceId, migration_id: execution.migrationId,
    request_sha256: owner.value.migration!.request_sha256, sources: inventory.sources.filter((source) => !managedKey(source.key)), shows: inventory.shows });
  const source = JSON.stringify(plan);
  if (new TextEncoder().encode(source).length > 8_000_000) throw new Error("Migration plan exceeds its persistence budget");
  await requireServiceMigration(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(`system/lifecycle-migrations/${execution.migrationId}/plan.json`, source,
    { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!written && JSON.stringify(await readPlan(env, execution)) !== JSON.stringify(plan)) throw new Error("Migration already has a different frozen plan");
  return plan;
}

async function verifyInventory(env: MigrationApplyEnv, execution: ServiceMigrationExecution, plan: FrozenMigrationPlan, initialized: boolean): Promise<void> {
  const expected = new Map(plan.sources.map((source) => [source.key, source]));
  const controls = new Map(targets(plan).map((target) => [target.key, target]));
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await env.CASTLOOP_BUCKET.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      if (++total > 100000) throw new Error("Migration verification inventory exceeds its object limit");
      if (managedKey(object.key)) continue;
      if (seen.has(object.key)) throw new Error("Migration verification has duplicate source keys");
      seen.add(object.key);
      const original = expected.get(object.key);
      const target = controls.get(object.key);
      if (original?.etag === object.etag && original.size === object.size && !(initialized && target?.mode === "initialize")) continue;
      if (!target || target.mode !== "initialize" || object.size > 16384) throw new Error("Migration source changed after its plan was frozen");
      const current = await env.CASTLOOP_BUCKET.get(object.key);
      if (!current || current.etag !== object.etag || current.size !== object.size ||
        JSON.stringify(target.parse(await current.text())) !== JSON.stringify(target.value)) throw new Error("Migration control changed outside its frozen plan");
    }
    await requireServiceMigration(env, execution);
    if (!page.truncated) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Migration verification cursor did not advance");
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (true);
  for (const key of expected.keys()) if (!seen.has(key)) throw new Error("Migration source disappeared after planning");
  if (initialized) for (const key of controls.keys()) if (!seen.has(key)) throw new Error("Migration control initialization is incomplete");
}

async function initializeTarget(env: MigrationApplyEnv, execution: ServiceMigrationExecution, plan: FrozenMigrationPlan, target: Target): Promise<void> {
  const object = await env.CASTLOOP_BUCKET.get(target.key);
  if (object) {
    if (object.size > 16384) throw new Error("Migration target is oversized");
    let same = false;
    try { same = JSON.stringify(target.parse(await object.text())) === JSON.stringify(target.value); }
    catch { if (target.mode === "preserve") throw new Error("Preserved migration control became invalid"); }
    if (same) return;
  }
  if (target.mode !== "initialize") throw new Error("Preserved lifecycle control changed during migration");
  const original = plan.sources.find((source) => source.key === target.key);
  if (original ? !object || object.etag !== original.etag || object.size !== original.size : object !== null) {
    throw new Error("Migration target changed before initialization");
  }
  await requireServiceMigration(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(target.key, target.source, { onlyIf: original ? { etagMatches: original.etag } : new Headers({ "If-None-Match": "*" }) });
  if (!written) throw new Error("Migration target CAS conflicted");
  await requireServiceMigration(env, execution);
}

async function readProgress(env: MigrationApplyEnv, execution: ServiceMigrationExecution, plan: FrozenMigrationPlan): Promise<{ value: MigrationApplyProgress; etag: string } | null> {
  const object = await env.CASTLOOP_BUCKET.get(`system/lifecycle-migrations/${execution.migrationId}/progress.json`);
  if (!object) return null;
  if (object.size > 16384) throw new Error("Migration progress is oversized");
  const value = migrationApplyProgressSchema.parse(await object.json<unknown>());
  if (value.migration_id !== execution.migrationId || value.service_id !== execution.serviceId || value.request_sha256 !== plan.request_sha256 ||
    value.plan_sha256 !== await hash(plan) || value.next_target > targets(plan).length) throw new Error("Migration progress does not match its frozen plan");
  return { value, etag: object.etag };
}

async function writeProgress(env: MigrationApplyEnv, execution: ServiceMigrationExecution, plan: FrozenMigrationPlan, input: MigrationApplyProgress): Promise<void> {
  await requireServiceMigration(env, execution);
  const value = migrationApplyProgressSchema.parse(input);
  const previous = await readProgress(env, execution, plan);
  if (previous?.value.phase === "finished") {
    if (JSON.stringify(previous.value) === JSON.stringify(value)) return;
    throw new Error("Finished migration progress cannot be changed");
  }
  const phases = ["applying", "verifying", "runtime", "finished"];
  if (previous && (value.next_target < previous.value.next_target || phases.indexOf(value.phase) < phases.indexOf(previous.value.phase))) {
    throw new Error("Migration progress cannot regress");
  }
  if (value.migration_id !== execution.migrationId || value.service_id !== execution.serviceId || value.request_sha256 !== plan.request_sha256 ||
    value.plan_sha256 !== await hash(plan) || value.next_target > targets(plan).length ||
    value.phase !== "applying" && value.next_target !== targets(plan).length) throw new Error("Migration progress write does not match its plan");
  await requireServiceMigration(env, execution);
  if (!await env.CASTLOOP_BUCKET.put(`system/lifecycle-migrations/${execution.migrationId}/progress.json`, JSON.stringify(value), {
    onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
  })) throw new Error("Migration progress CAS conflicted");
}

export async function runLifecycleMigrationStep(env: MigrationApplyEnv, serviceId: string, migrationId: string,
  effects: MigrationApplyEffects, options: { maximumTargets?: number } = {}): Promise<MigrationApplyResult> {
  const maximum = options.maximumTargets ?? 20;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("Invalid migration step limit");
  const current = await readServiceAdmission(env, serviceId);
  if (current?.value.mode === "m6" && current.value.readiness?.migration_id === migrationId) return { state: "completed", phase: "finished" };
  const execution = await acquireServiceMigrationExecution(env, serviceId, migrationId);
  let plan: FrozenMigrationPlan | undefined;
  let phase: MigrationApplyProgress["phase"] = "applying";
  try {
    await effects.checkQuiescence(execution);
    await requireServiceMigration(env, execution);
    plan = await freezePlan(env, execution);
    let progress = (await readProgress(env, execution, plan))?.value ?? migrationApplyProgressSchema.parse({ schema_version: 1,
      migration_id: migrationId, service_id: serviceId, request_sha256: plan.request_sha256, plan_sha256: await hash(plan), phase: "applying", next_target: 0 });
    phase = progress.phase;
    await verifyInventory(env, execution, plan, progress.phase !== "applying");
    if (progress.phase === "applying") {
      const controls = targets(plan);
      const end = Math.min(controls.length, progress.next_target + maximum);
      for (let index = progress.next_target; index < end; index += 1) await initializeTarget(env, execution, plan, controls[index]!);
      progress = { ...progress, next_target: end, phase: end === controls.length ? "verifying" : "applying" };
      await writeProgress(env, execution, plan, progress);
      return { state: "pending", phase: progress.phase };
    }
    if (progress.phase === "verifying") {
      progress = { ...progress, phase: "runtime" };
      await writeProgress(env, execution, plan, progress);
      return { state: "pending", phase: "runtime" };
    }
    if (progress.phase === "runtime") {
      const runtime = migrationRuntimeProofSchema.parse(await effects.verifyCutover(execution));
      await requireServiceMigration(env, execution);
      await verifyInventory(env, execution, plan, true);
      progress = { ...progress, phase: "finished", runtime, completed_execution_id: execution.executionId };
      delete progress.reason_code;
      await writeProgress(env, execution, plan, progress);
    } else if (progress.phase === "finished") {
      const runtime = migrationRuntimeProofSchema.parse(await effects.verifyCutover(execution));
      if (JSON.stringify(runtime) !== JSON.stringify(progress.runtime)) throw new Error("Migration runtime changed after its completion evidence was saved");
      await requireServiceMigration(env, execution);
      await verifyInventory(env, execution, plan, true);
    }
    const readiness = serviceAdmissionSchema.shape.readiness.unwrap().parse({ migration_id: migrationId, plan_sha256: progress.plan_sha256,
      ...progress.runtime, completed_execution_id: progress.completed_execution_id });
    await completeServiceMigration(env, execution, readiness);
    return { state: "completed", phase: "finished" };
  } catch (error) {
    const current = await readServiceAdmission(env, serviceId);
    if (current?.value.mode === "m6" && current.value.readiness?.migration_id === migrationId) return { state: "completed", phase: "finished" };
    if (plan) {
      const progress = await readProgress(env, execution, plan);
      if (progress && progress.value.phase !== "finished") await writeProgress(env, execution, plan, { ...progress.value,
        reason_code: phase === "runtime" ? "migration_runtime_failed" : phase === "applying" ? "migration_apply_failed" : "migration_inventory_failed" });
    }
    throw error;
  } finally {
    const owner = (await readServiceAdmission(env, serviceId))?.value.migration;
    if (owner?.execution_id === execution.executionId) await releaseServiceMigrationExecution(env, execution);
  }
}
