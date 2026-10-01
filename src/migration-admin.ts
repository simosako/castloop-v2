import { z } from "zod";
import { migrationBootstrapRequestSchema, migrationDeploymentSettlementSchema, migrationQuiescenceSchema,
  migrationAdminStatusSchema, migrationApplyProgressSchema, migrationBootstrapSchema, parseServiceConfig,
  serviceMigrationRequestSchema, migrationServiceIdentitySchema, migrationOperationIdentitySchema, migrationPauseRequestSchema,
  migrationInitializationRequestSchema, migrationInitializationResultSchema } from "../packages/shared/src/index";
import type { ServiceConfig } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { runLifecycleMigrationStep } from "./lifecycle-migration-apply";
import type { MigrationApplyEnv } from "./lifecycle-migration-apply";
import { beginBootstrapDeployment, confirmMigrationQuiescence, prepareBootstrapDeployment, requireMigrationQuiescence,
  settleBootstrapDeployment, verifyBootstrapDeliveryStep } from "./migration-bootstrap";
import type { BootstrapRuntime } from "./migration-bootstrap";
import { abortUnstartedServiceMigration, acquireServiceMigrationExecution, claimServiceMigration, initializeServiceAdmission,
  pauseServiceAdmission, readServiceAdmission, releaseServiceMigrationExecution, resumeServiceAdmission } from "./service-admission";
import type { ServiceMigrationExecution } from "./service-admission";

const identity = migrationServiceIdentitySchema.shape;
const operation = migrationOperationIdentitySchema.shape;
const bootstrapIdSchema = z.object({ ...operation, bootstrap_id: z.uuid() }).strict();
const settlementSchema = z.object({ ...operation, settlement: migrationDeploymentSettlementSchema }).strict();
const verifySchema = z.object({ ...operation, maximum_assets: z.number().int().min(1).max(20).optional() }).strict();
const ROUTES = new Set(["initialize-admission", "pause", "resume-legacy", "claim", "abort-unstarted", "quiescence", "apply",
  "prepare-deployment", "begin-deployment", "settle-deployment", "verify-delivery"]);
const MAX_BODY = 16384;

function reply(input: object, status = 200): Response {
  return Response.json(input, { status, headers: { "Cache-Control": "no-store" } });
}

async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) throw new Error("Request body exceeds limit");
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new Error("Request body exceeds limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

export async function handleMigrationAdmin(request: Request, env: MigrationApplyEnv & { CASTLOOP_ADMIN_KEY: string },
  runtime: BootstrapRuntime): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/admin/migration/")) return null;
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  const route = path.slice("/admin/migration/".length);
  if (route !== "status" && !ROUTES.has(route)) return reply({ error: "not found" }, 404);
  if (request.method !== (route === "status" ? "GET" : "POST")) return reply({ error: "method not allowed" }, 405);
  let config: ServiceConfig;
  try {
    const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
    if (!object || object.size < 1 || object.size > MAX_BODY) throw new Error("Invalid service config");
    config = parseServiceConfig(await object.text());
  } catch { return reply({ error: "Service configuration unavailable", reason_code: "migration_config_failed" }, 503); }
  const serviceId = config.service_id;
  if (route === "status") {
    try {
      const admission = (await readServiceAdmission(env, serviceId))?.value ?? null;
      const migrationId = admission?.migration?.migration_id ?? admission?.readiness?.migration_id;
      const progress = migrationId ? await env.CASTLOOP_BUCKET.get(`system/lifecycle-migrations/${migrationId}/progress.json`) : null;
      const bootstrap = migrationId ? await env.CASTLOOP_BUCKET.get(`system/lifecycle-migrations/${migrationId}/bootstrap.json`) : null;
      if (progress && progress.size > MAX_BODY || bootstrap && bootstrap.size > MAX_BODY) throw new Error("Oversized migration status");
      return reply(migrationAdminStatusSchema.parse({ service_id: config.service_id, account_id: config.account_id, worker_name: config.worker_name,
        admission, progress: progress ? migrationApplyProgressSchema.parse(await progress.json<unknown>()) : null,
        bootstrap: bootstrap ? migrationBootstrapSchema.parse(await bootstrap.json<unknown>()) : null,
        worker_protocol: runtime.protocol, worker_version_id: runtime.workerVersionId, m6_ready: false,
        ...(runtime.workerBootstrapId ? { worker_bootstrap_id: runtime.workerBootstrapId } : {}),
        ...(runtime.workerBridgeId ? { worker_bridge_id: runtime.workerBridgeId } : {}) }));
    }
    catch { return reply({ error: "Migration status unavailable", reason_code: "migration_status_failed" }, 503); }
  }
  let input: unknown;
  try { input = await boundedJson(request); }
  catch { return reply({ error: "Invalid or oversized JSON body", reason_code: "migration_input_invalid" }, 400); }
  let action: () => Promise<object>;
  const bridge = () => {
    if (runtime.protocol !== "legacy_fenced") throw new Error("Operation requires the migration bridge");
    z.uuid().parse(runtime.workerVersionId);
  };
  const execute = async (migrationId: string, callback: (execution: ServiceMigrationExecution) => Promise<object>): Promise<object> => {
    const execution = await acquireServiceMigrationExecution(env, serviceId, migrationId);
    try { return await callback(execution); }
    finally { await releaseServiceMigrationExecution(env, execution); }
  };
  try {
    const common = z.object(identity).parse(input);
    if (common.service_id !== serviceId) throw new Error("Service ID mismatch");
    if (route === "initialize-admission") {
      migrationServiceIdentitySchema.parse(input);
      action = async () => { bridge(); await initializeServiceAdmission(env, serviceId); return { result: "initialized" }; };
    } else if (route === "pause" || route === "resume-legacy") {
      const value = migrationPauseRequestSchema.parse(input);
      action = async () => {
        bridge();
        if (route === "pause") await pauseServiceAdmission(env, serviceId, value.pause_id);
        else {
          if ((await readServiceAdmission(env, serviceId))?.value.mode !== "legacy") throw new Error("Legacy resume cannot open M6 admission");
          await resumeServiceAdmission(env, serviceId, value.pause_id);
        }
        return { result: route === "pause" ? "paused" : "resumed" };
      };
    } else if (route === "claim") {
      const value = serviceMigrationRequestSchema.parse(input);
      action = async () => { bridge(); await claimServiceMigration(env, value); return { result: "claimed" }; };
    } else if (route === "abort-unstarted") {
      const value = migrationOperationIdentitySchema.parse(input);
      action = async () => { bridge(); await abortUnstartedServiceMigration(env, serviceId, value.migration_id); return { result: "paused" }; };
    } else if (route === "quiescence") {
      const value = migrationQuiescenceSchema.parse(input);
      action = () => execute(value.migration_id, async (execution) => {
        await confirmMigrationQuiescence(env, execution, value, runtime); return { result: "confirmed" };
      });
    } else if (route === "apply") {
      const value = migrationInitializationRequestSchema.parse(input);
      action = async () => {
        bridge();
        const result = await runLifecycleMigrationStep(env, serviceId, value.migration_id, {
          checkQuiescence: (execution) => requireMigrationQuiescence(env, execution),
          verifyCutover: async () => { throw new Error("Full M6 route cutover is not released"); },
        }, { maximumTargets: value.maximum_targets, initializeOnly: true });
        return migrationInitializationResultSchema.parse(result);
      };
    } else if (route === "prepare-deployment") {
      const value = migrationBootstrapRequestSchema.parse(input);
      action = () => execute(value.migration_id, async (execution) => {
        await prepareBootstrapDeployment(env, execution, value, runtime); return { result: "prepared" };
      });
    } else if (route === "begin-deployment") {
      const value = bootstrapIdSchema.parse(input);
      action = () => execute(value.migration_id, (execution) => beginBootstrapDeployment(env, execution, value.bootstrap_id, runtime));
    } else if (route === "settle-deployment") {
      const value = settlementSchema.parse(input);
      action = () => execute(value.migration_id, async (execution) => {
        await settleBootstrapDeployment(env, execution, value.settlement, runtime); return { result: "verifying" };
      });
    } else {
      const value = verifySchema.parse(input);
      action = () => execute(value.migration_id, (execution) => verifyBootstrapDeliveryStep(env, execution, runtime, value.maximum_assets));
    }
  } catch { return reply({ error: "Invalid migration input", reason_code: "migration_input_invalid" }, 400); }
  try { return reply(await action()); }
  catch {
    console.error(JSON.stringify({ event: "migration_operation_blocked", reason_code: "migration_operation_blocked" }));
    return reply({ error: "Migration operation blocked; inspect admission and retained progress", reason_code: "migration_operation_blocked" }, 409);
  }
}
