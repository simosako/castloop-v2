import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { continueSqliteServiceUpdateVerification, readSqliteServiceUpdate, reconcileSqliteServiceUpdate, updateSqliteService } from "./sqlite-service-update";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";
import { administratorKey } from "./administrator-key";
import { createLocalJournalStorage } from "./local-journal-storage";
import { sha256HexSync as digest } from "./sha256";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { sqliteUpdateResultSchema } from "../../shared/src/sqlite-runtime-update";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
const wait = { attempts: 2, delay: async () => {} };
const deploymentsResponse = z.object({ result: z.object({ deployments: z.array(z.object({ id: z.uuid(),
  versions: z.array(z.object({ version_id: z.uuid(), percentage: z.number() })) })) }) }).loose();
const versionResponse = z.object({ result: z.object({ id: z.uuid(),
  resources: z.object({ script: z.object({ etag: z.string() }) }).loose() }).loose() }).loose();

async function initializedService() {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "initial source", value.options, wait);
  return value;
}

async function interruptedUpdate(target: "deployments" | "settings" | "version") {
  const value = await initializedService();
  const id = crypto.randomUUID(); let deployed = false, interrupted = false;
  let checkpoint: ReturnType<typeof readSqliteServiceUpdate> = null, uploadedSource = "";
  value.faults.afterDeploy = () => { deployed = true; };
  const transport: typeof value.transport = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (init?.method === "PUT" && init.body instanceof FormData) uploadedSource = await (init.body.get("index.js") as File).text();
    if (deployed && !checkpoint) checkpoint = readSqliteServiceUpdate(value.root, value.config, id);
    if (deployed && !interrupted && (target === "version" ? path.includes("/versions/") : path.endsWith(`/${target}`))) {
      interrupted = true; throw new Error("simulated post-deployment GET timeout");
    }
    return value.transport(input, init);
  };
  const options = { ...value.options, transport };
  await expect(updateSqliteService(value.root, value.config, id, "new source", options, wait)).rejects.toThrow();
  expect(interrupted).toBe(true); expect(value.runtime.ready()).toBe(false);
  expect(value.calls.filter((call) => call.method === "PUT" && call.path.startsWith("/workers/scripts/"))).toHaveLength(2);
  expect(value.calls.some((call) => call.path.endsWith("update-activate"))).toBe(false);
  expect(checkpoint).toMatchObject({ schema_version: 2, phase: "deploy_acknowledged", upload_receipt: { script_etag: digest(uploadedSource) } });
  expect(checkpoint!.request.worker_source_sha256).toBe(digest(uploadedSource));
  expect(uploadedSource).toBe(`new source\n// castloop SQLite update operation: ${id}\n`);
  value.calls.length = 0;
  return { value, id, transport, options };
}

for (const target of ["deployments", "settings", "version"] as const) {
  test(`acknowledged deployment continues after ${target} GET failure without another PUT or prepare`, async () => {
    const { value, id, transport, options } = await interruptedUpdate(target);
    const state = readSqliteServiceUpdate(value.root, value.config, id)!;
    expect(state.phase).toBe(target === "settings" ? "deployed" : "deploy_acknowledged");
    expect(state.receipt !== undefined).toBe(target === "settings");
    await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "changed source", options, wait)).rejects.toThrow();
    expect(value.calls).toHaveLength(0);
    const result = await runSqliteCommand(value.root, value.config, "update-service-verify", [id], {
      workerSource: async () => "new source", cloudflare: options, transport });
    expect(result).toMatchObject({ phase: "ready" });
    expect(value.runtime.health()).toMatchObject({ publication_ready: true, state: "paused", drained: true });
    expect(value.calls.filter((call) => call.method !== "GET")).toEqual([{ method: "POST", path: "/admin/sqlite-service/update-activate" }]);
    expect(readSqliteServiceUpdate(value.root, value.config, id)?.phase).toBe("ready");
  });
}

test("repeated failed verification retains its checkpoint, never redeploys, and cannot be mistaken for read-only completion", async () => {
  const { value, id, options } = await interruptedUpdate("deployments");
  await expect(updateSqliteService(value.root, value.config, id, "new source", options, wait)).rejects.toThrow("already started");
  await expect(reconcileSqliteServiceUpdate(value.root, value.config, id, options)).rejects.toThrow("no completed-runtime");
  expect(value.calls).toHaveLength(0);
  value.faults.settings = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", options, wait)).rejects.toThrow();
    expect(readSqliteServiceUpdate(value.root, value.config, id)?.phase).toBe("deployed");
    expect(value.runtime.ready()).toBe(false);
  }
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
  value.faults.settings = false;
  expect((await continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", options, wait)).phase).toBe("ready");
});

for (const drift of ["bucket_name", "worker_name", "public_base_url"] as const) {
  test(`continuation rejects changed ${drift} before any remote request`, async () => {
    const { value, id, options } = await interruptedUpdate("deployments");
    const config = { ...value.config, [drift]: drift === "public_base_url" ? "https://different.example.com" : "different-target",
      ...(drift === "worker_name" ? { workers_dev_base_url: "https://different-target.example.workers.dev" } : {}) };
    await expect(continueSqliteServiceUpdateVerification(value.root, config, id, "new source", options, wait)).rejects.toThrow("frozen source/configuration");
    expect(value.calls).toHaveLength(0);
  });
}

for (const drift of ["etag", "version", "split", "previous", "namespace", "settings", "maintenance", "deployment-race"] as const) {
  test(`acknowledged upload never activates with ${drift} drift`, async () => {
    const { value, id } = await interruptedUpdate("deployments");
    const previous = readSqliteServiceUpdate(value.root, value.config, id)!.previous;
    let deployments = 0;
    const transport: typeof value.transport = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      const response = await value.transport(input, init);
      if (path.includes("/versions/")) {
        const body = versionResponse.parse(await response.json());
        if (drift === "etag") body.result.resources.script.etag = "unrelated-upload";
        if (drift === "version") body.result.id = crypto.randomUUID();
        return Response.json(body);
      }
      if (path.endsWith("/deployments")) {
        const body = deploymentsResponse.parse(await response.json()), deployment = body.result.deployments[0]; deployments++;
        if (drift === "split") deployment.versions.push({ version_id: crypto.randomUUID(), percentage: 0 });
        if (drift === "previous") { deployment.id = previous.deployment_id; deployment.versions[0].version_id = previous.worker_version_id; }
        if (drift === "deployment-race" && deployments >= 3) deployment.id = crypto.randomUUID();
        return Response.json(body);
      }
      if (drift === "maintenance" && path.includes("/update-status/")) {
        const body = sqliteUpdateResultSchema.parse(await response.json()); body.request.operation_id = crypto.randomUUID();
        return new Response(JSON.stringify(body), { headers: response.headers });
      }
      return response;
    };
    if (drift === "namespace" || drift === "settings") value.faults[drift] = true;
    await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", { ...value.options, transport }, wait)).rejects.toThrow();
    expect(value.calls.every((call) => call.method === "GET")).toBe(true);
    expect(value.runtime.ready()).toBe(false);
    expect(readSqliteServiceUpdate(value.root, value.config, id)?.phase).not.toBe("activation_requested");
  });
}

test("a pinned deployed receipt cannot be replaced by a different deployment during continuation", async () => {
  const { value, id } = await interruptedUpdate("settings");
  const retained = readSqliteServiceUpdate(value.root, value.config, id)!;
  const transport: typeof value.transport = async (input, init) => {
    const response = await value.transport(input, init);
    if (new URL(input instanceof Request ? input.url : input).pathname.endsWith("/deployments")) {
      const body = deploymentsResponse.parse(await response.json()); body.result.deployments[0].id = crypto.randomUUID(); return Response.json(body);
    }
    return response;
  };
  await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", { ...value.options, transport }, wait)).rejects.toThrow("receipt differs");
  expect(readSqliteServiceUpdate(value.root, value.config, id)).toEqual(retained);
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});

for (const lost of ["transport", "body"] as const) {
  test(`unconfirmed PUT ${lost} cannot be promoted from a currently deployed version`, async () => {
    const value = await initializedService(), id = crypto.randomUUID();
    const transport: typeof value.transport = async (input, init) => {
      const response = await value.transport(input, init);
      if (init?.method === "PUT") {
        if (lost === "transport") throw new Error("lost upload response");
        return new Response('{"success":true,"result":');
      }
      return response;
    };
    const options = { ...value.options, transport };
    await expect(updateSqliteService(value.root, value.config, id, "new source", options, wait)).rejects.toThrow();
    expect(readSqliteServiceUpdate(value.root, value.config, id)).toMatchObject({ phase: "deploy_requested" });
    expect(readSqliteServiceUpdate(value.root, value.config, id)?.upload_receipt).toBeUndefined();
    value.calls.length = 0;
    await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", options, wait)).rejects.toThrow("no prior activation request");
    expect(value.calls).toHaveLength(0); expect(value.runtime.ready()).toBe(false);
  });
}

for (const lost of ["before", "after"] as const) {
  test(`activation interrupted ${lost} server acceptance is never replayed by verification`, async () => {
    const value = await initializedService(), id = crypto.randomUUID(); let activationAttempted = false;
    const transport: typeof value.transport = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (activationAttempted && path.includes("/update-status/")) throw new Error("status unavailable");
      if (path.endsWith("/update-activate")) {
        activationAttempted = true;
        if (lost === "after") await value.transport(input, init);
        throw new Error("activation response unknown");
      }
      return value.transport(input, init);
    };
    const options = { ...value.options, transport };
    await expect(updateSqliteService(value.root, value.config, id, "new source", options, wait)).rejects.toThrow();
    expect(readSqliteServiceUpdate(value.root, value.config, id)?.phase).toBe("activation_requested");
    value.calls.length = 0;
    await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", value.options, wait)).rejects.toThrow("no prior activation request");
    expect(value.calls).toHaveLength(0);
    if (lost === "after") expect((await reconcileSqliteServiceUpdate(value.root, value.config, id, value.options)).phase).toBe("ready");
    else await expect(reconcileSqliteServiceUpdate(value.root, value.config, id, value.options)).rejects.toThrow("not verified");
    expect(value.calls.every((call) => call.method === "GET")).toBe(true);
  });
}

test("successive updates of identical embedded code have operation-specific source hashes and acknowledged ETags", async () => {
  const value = await initializedService();
  const first = await updateSqliteService(value.root, value.config, crypto.randomUUID(), "same source", value.options, wait);
  const second = await updateSqliteService(value.root, value.config, crypto.randomUUID(), "same source", value.options, wait);
  expect(second.request.worker_source_sha256).not.toBe(first.request.worker_source_sha256);
  expect(second.upload_receipt!.script_etag).not.toBe(first.upload_receipt!.script_etag);
});

test("legacy SQLite deployed journals retain their original hashes and can continue without being upgraded", async () => {
  const value = await initializedService(), id = crypto.randomUUID();
  const previous = await new SqliteCloudflareApi(value.config, value.options).current();
  const request = { service_id: value.config.service_id, service_config_sha256: value.runtime.health().service_config_sha256,
    worker_version_id: previous.worker_version_id, operation_id: id, worker_source_sha256: digest("new source"),
    worker_metadata_sha256: digest(JSON.stringify(buildSqliteWorkerMetadata(value.config, administratorKey(value.root)))), namespace_id: previous.namespace_id };
  createLocalJournalStorage(value.root, "sqlite-service-updates", value.config.service_id, `${id}.json`).initialize({
    protocol: "sqlite-sequential-v1", phase: "prepared", previous, request });
  value.faults.afterDeploy = () => { value.faults.failFirstInspection = true; };
  await expect(updateSqliteService(value.root, value.config, id, "new source", value.options, wait)).rejects.toThrow();
  expect(readSqliteServiceUpdate(value.root, value.config, id)).toMatchObject({ phase: "deployed", request });
  value.calls.length = 0;
  const ready = await continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", value.options, wait);
  expect(ready.phase).toBe("ready"); expect(ready.schema_version).toBeUndefined(); expect(ready.upload_receipt).toBeUndefined();
  expect(ready.request).toEqual(request);
  expect(value.calls.filter((call) => call.method !== "GET")).toEqual([{ method: "POST", path: "/admin/sqlite-service/update-activate" }]);
});

test("legacy receipt-free deploy_requested journals remain blocked without any remote request or automatic promotion", async () => {
  const { value, id } = await interruptedUpdate("deployments");
  const state = readSqliteServiceUpdate(value.root, value.config, id)!;
  delete state.schema_version; delete state.upload_receipt; state.phase = "deploy_requested"; state.request.worker_source_sha256 = digest("new source");
  const file = join(value.root, ".castloop", "sqlite-service-updates", value.config.service_id, `${id}.json`);
  writeFileSync(file, JSON.stringify(state)); const bytes = readFileSync(file, "utf8");
  await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", value.options, wait)).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe(bytes); expect(value.calls).toHaveLength(0);
});

test("strict journal validation binds acknowledgment evidence to its phase, format and deployment ETag", async () => {
  const { value, id } = await interruptedUpdate("settings");
  const state = readSqliteServiceUpdate(value.root, value.config, id)!;
  const file = join(value.root, ".castloop", "sqlite-service-updates", value.config.service_id, `${id}.json`);
  const invalid = [
    { ...state, upload_receipt: undefined },
    { ...state, schema_version: undefined },
    { ...state, phase: "deploy_requested", receipt: undefined },
    { ...state, phase: "deploy_acknowledged" },
    { ...state, upload_receipt: { script_etag: "other-etag" } },
    { ...state, schema_version: 3 },
    { ...state, receipt: { ...state.receipt, worker_version_id: state.previous.worker_version_id } },
    { ...state, receipt: { ...state.receipt, deployment_id: state.previous.deployment_id } },
  ];
  for (const record of invalid) {
    writeFileSync(file, JSON.stringify(record));
    expect(() => readSqliteServiceUpdate(value.root, value.config, id)).toThrow();
  }
  expect(value.calls).toHaveLength(0);
});
