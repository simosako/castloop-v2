import { inspectM6WorkerDeployment, M6_FRESH_WORKER_COMPATIBILITY_DATE, m6SetupCompleteSchema, m6SetupCompletedSchema,
  m6SetupRecordSchema, m6SetupRequestSchema, m6SetupStatusSchema, m6SnapshotReads } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { completeM6ServiceInitialization, prepareM6ServiceInitialization } from "./m6-service-initialization";
import type { M6InitializationEnv } from "./m6-service-initialization";
import { m6SetupRecordKey, readM6SetupRecord, requireM6SetupOwner } from "./m6-setup-record";
import { describeM6SetupProbe, verifyM6SetupRuntime } from "./m6-setup-runtime";
import type { M6SetupRuntime } from "./m6-setup-runtime";
import { readM6RuntimeConfiguration } from "./m6-runtime-readiness";
import type { M6RuntimeChecks } from "./m6-runtime-readiness";
import { readServiceAdmission } from "./service-admission";
import { completeM6ServiceUpdate, prepareM6ServiceUpdate } from "./m6-service-update";

type SetupEnv = M6InitializationEnv & { CASTLOOP_ADMIN_KEY: string; CASTLOOP_QUEUE: Pick<Queue, "send"> };
function reply(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleM6SetupAdmin(request: Request, env: SetupEnv, runtime: M6SetupRuntime): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/setup/")) return null;
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ reason_code: "setup_unauthorized" }, 401);
  const route = url.pathname.slice("/admin/setup/".length);
  if (!["prepare", "status", "probe", "complete"].includes(route)) return reply({ reason_code: "setup_route_unknown" }, 404);
  if (request.method !== (route === "probe" ? "GET" : "POST")) return reply({ reason_code: "setup_method_invalid" }, 405);
  let input: unknown;
  try {
    if (route === "probe") {
      const operationId = m6SetupRequestSchema.shape.target.shape.operation_id.parse(url.searchParams.get("operation_id"));
      const object = await env.CASTLOOP_BUCKET.get(m6SetupRecordKey(operationId));
      if (!object || object.size > 16384) throw new Error("Missing runtime probe");
      const record = m6SetupRecordSchema.parse(await object.json<unknown>());
      input = m6SetupRequestSchema.parse(record.request);
    } else input = await readBoundedAdminJson(request);
    input = route === "complete" ? m6SetupCompleteSchema.parse(input) : m6SetupRequestSchema.parse(input);
  } catch { return reply({ reason_code: "setup_input_invalid" }, 400); }
  const frozen = route === "complete" ? m6SetupCompleteSchema.parse(input) : m6SetupRequestSchema.parse(input);
  const owner = { target: frozen.target, ...(frozen.update_request ? { update_request: frozen.update_request } : {}) };
  try {
    if (route === "prepare") {
      if (owner.update_request) await prepareM6ServiceUpdate(env, owner.update_request, owner.target);
      else await prepareM6ServiceInitialization(env, owner.target);
      await requireM6SetupOwner(env, owner);
      const existing = await readM6SetupRecord(env, owner);
      if (!existing) {
        const { config } = await readM6RuntimeConfiguration(env, owner.target.service_config_sha256, owner.target.worker_version_id);
        const admission = (await readServiceAdmission(env, config.service_id))!.value;
        if (!["initializing", "updating"].includes(admission.state)) throw new Error("Completed runtime cannot acquire a new runtime probe");
        await runtime.invalidate(`setup-${owner.target.operation_id.slice(0, 20)}`);
        await requireM6SetupOwner(env, owner);
        const value = m6SetupRecordSchema.parse({ schema_version: 1, request: owner, cache_purge_verified: true });
        if (!await env.CASTLOOP_BUCKET.put(m6SetupRecordKey(owner.target.operation_id), JSON.stringify(value), { onlyIf: new Headers({ "If-None-Match": "*" }) })) {
          throw new Error("Runtime probe preparation conflicted; do not replay Queue send");
        }
        await env.CASTLOOP_QUEUE.send({ ...owner, type: "castloop-runtime-probe-v1" });
      }
    }
    await requireM6SetupOwner(env, owner);
    if (route === "probe") return reply(await describeM6SetupProbe(env, owner, runtime));
    if (route === "complete") {
      const completion = m6SetupCompleteSchema.parse(frozen);
      let inspection = 0;
      const checks: M6RuntimeChecks = {
        inspectDeployment: (config, versionId) => inspectM6WorkerDeployment(config, versionId,
          m6SnapshotReads(completion.snapshots[inspection++]!), M6_FRESH_WORKER_COMPATIBILITY_DATE),
        verifyRuntime: () => verifyM6SetupRuntime(env, owner, runtime),
      };
      const readiness = owner.update_request ? await completeM6ServiceUpdate(env, owner.update_request, owner.target, checks) :
        await completeM6ServiceInitialization(env, owner.target, checks);
      return reply(m6SetupCompletedSchema.parse({ result: owner.update_request ? "updated" : "initialized", request: owner, readiness }));
    }
    const record = await readM6SetupRecord(env, owner);
    if (!record) throw new Error("Runtime probe was not prepared");
    return reply(m6SetupStatusSchema.parse({ result: "setup-status", record: record.value }));
  } catch {
    console.error(JSON.stringify({ event: "m6_setup_blocked", reason_code: "setup_operation_blocked" }));
    return reply({ reason_code: "setup_operation_blocked" }, 409);
  }
}
