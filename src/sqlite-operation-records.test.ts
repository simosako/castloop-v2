import { afterEach, expect, test } from "bun:test";
import { operationCommandSchema, operationSpecSchema } from "../packages/shared/src/sqlite-operations";
import type { OperationCommand } from "../packages/shared/src/sqlite-operations";
import { SqliteOperationRecords } from "./sqlite-operation-records";
import { createSqliteOperationHttp } from "./sqlite-operation-http";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function fixture() {
  const f = sqlitePublicationFixture(); cleanups.push(f.close);
  const client = { client_id: crypto.randomUUID(), cli_version: "0.6.1" };
  let targetValid = true;
  const records = new SqliteOperationRecords(f.storage, () => f.queue.identity(), () => targetValid, () => 1000);
  f.queue.operationRecords = records;
  const publication = f.request(), id = crypto.randomUUID();
  const register = operationCommandSchema.parse({ schema_version: 1, ...f.runtime, operation_id: id, request_id: crypto.randomUUID(),
    expected_version: 0, action: "register", operation: { operation_id: id, kind: "upload", target_kind: publication.kind,
      show_id: publication.show_id, episode_id: publication.episode_id, job_id: publication.job_id,
      worker_version_id: f.runtime.worker_version_id, service_config_sha256: f.runtime.service_config_sha256,
      admission_window_id: f.windowId, expected_show_state_version: 0, input_sha256: "c".repeat(64) },
    assets: publication.payloads.map(({ etag, version, verified, ...asset }) => asset) });
  const change = (action: OperationCommand["action"], fields: Partial<OperationCommand> = {}) => records.command(operationCommandSchema.parse({
    schema_version: 1, ...f.runtime, operation_id: id, request_id: crypto.randomUUID(), expected_version: records.get(id)!.version, action, ...fields }), client);
  const verified = async (attach = true) => {
    await records.command(register, client);
    for (const asset of publication.payloads) {
      await change("begin_upload", { upload_id: asset.upload_id });
      await change("report_upload", { upload_id: asset.upload_id, receipt: { etag: asset.etag, version: asset.version } });
      await change("verify_upload", { upload_id: asset.upload_id });
      if (attach) await change("attach_asset", { upload_id: asset.upload_id });
    }
  };
  return { ...f, records, register, publication, client, id, change, verified, invalidate: () => { targetValid = false; } };
}

test("operation DDL, origin, duplicate identity and rejected versions retain an atomic history", async () => {
  const f = fixture(), first = await f.records.command(f.register, f.client);
  expect(first.operation).toMatchObject({ version: 1, state: "prepared" });
  const detail = f.records.detail(f.id)!;
  expect(detail.requests[0]).toMatchObject({ client_id: f.client.client_id, received_at_ms: 1000, outcome: "applied" });
  expect(detail.events[0]).toMatchObject({ operation_version: 1, request_id: f.register.request_id, actor_type: "client" });
  expect(await f.records.command(f.register, f.client)).toEqual(first);
  expect(f.records.detail(f.id)!.events).toHaveLength(1);
  await expect(f.records.command(f.register, { ...f.client, client_id: crypto.randomUUID() })).rejects.toThrow("identity conflicts");
  const rejected = await f.change("begin_upload", { expected_version: 0, upload_id: f.publication.payloads[0]!.upload_id });
  expect(rejected.request).toMatchObject({ outcome: "rejected", reason_code: "version_conflict" });
  expect(rejected.operation.version).toBe(1);
  expect(f.records.detail(f.id)!.events).toHaveLength(1);
  expect(() => f.storage.sql.exec("DELETE FROM operations WHERE operation_id = ?", f.id)).toThrow();
  expect(() => f.storage.sql.exec("UPDATE operation_assets SET upload_state = 'verified' WHERE operation_id = ?", f.id)).toThrow();
});

test("begin and cancellation competing for one version admit exactly one instruction", async () => {
  const f = fixture(); await f.records.command(f.register, f.client);
  const results = await Promise.all([f.change("begin_upload", { upload_id: f.publication.payloads[0]!.upload_id, expected_version: 1 }),
    f.change("cancel", { expected_version: 1 })]);
  expect(results.filter((result) => result.request.outcome === "applied")).toHaveLength(1);
  expect(results.filter((result) => result.request.reason_code === "version_conflict")).toHaveLength(1);
  expect(f.records.get(f.id)!.version).toBe(2);
});

test("unacknowledged PUTs cannot resume, cancel or enter cleanup, regardless of elapsed time", async () => {
  const f = fixture(); await f.records.command(f.register, f.client);
  await f.change("begin_upload", { upload_id: f.publication.payloads[0]!.upload_id });
  expect((await f.change("resume")).request.outcome).toBe("rejected");
  expect((await f.change("cancel")).request.outcome).toBe("rejected");
  await expect(f.records.cleanupPlan(f.id)).rejects.toThrow("cancelled upload");
  expect(f.records.get(f.id)!.state).toBe("in_progress");
});

test("upload target changes and cross-operation asset references cannot advance checkpoints", async () => {
  const f = fixture(); await f.records.command(f.register, f.client);
  expect((await f.change("begin_upload", { upload_id: crypto.randomUUID() })).request.reason_code).toBe("asset_conflict");
  f.invalidate();
  expect((await f.change("begin_upload", { upload_id: f.publication.payloads[0]!.upload_id })).request.reason_code).toBe("target_conflict");
  expect(f.records.assets(f.id).every((asset) => asset.upload_state === "prepared")).toBe(true);
});

test("publication acceptance and synchronous completion are retained atomically in the queue transaction", async () => {
  const f = fixture(); await f.verified();
  const invocation = crypto.randomUUID();
  const accepted = await f.queue.enqueue(f.publication, f.client, invocation);
  expect(accepted.state).toBe("succeeded");
  expect((await f.change("cancel")).request.outcome).toBe("rejected");
  const detail = f.records.detail(f.publication.job_id)!;
  expect(detail.operation.state).toBe("succeeded");
  expect(detail.events.map((event) => event.actor_type)).toEqual(["client", "worker"]);
  expect(detail.events.every((event) => event.invocation_id === invocation)).toBe(true);
  expect(detail.requests[0]!.outcome).toBe("applied");
  await expect(f.queue.enqueue(f.publication, { ...f.client, client_id: crypto.randomUUID() })).rejects.toThrow();
});

test("failed publication effect rolls operation admission back with the uncommitted job", async () => {
  const f = fixture(); await f.verified();
  f.queue.executor = { execute: async () => { throw new Error("transient effect failure"); } };
  await expect(f.queue.enqueue(f.publication, f.client)).rejects.toThrow("transient effect failure");
  expect(f.records.get(f.publication.job_id)).toBeNull();
  expect(f.queue.status(f.publication.request_id)).toBeNull();
  expect(f.records.get(f.id)!.state).toBe("succeeded");
});

test("cleanup reserves exact unused objects before IO and blocks publication even by an older client", async () => {
  const f = fixture(); await f.verified(); await f.change("cancel");
  const plan = await f.records.cleanupPlan(f.id), deleted: string[] = [];
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  const command = operationCommandSchema.parse({ schema_version: 1, ...f.runtime, operation_id: crypto.randomUUID(), request_id: crypto.randomUUID(),
    expected_version: 0, action: "cleanup", cleanup: { source_operation_id: f.id, source_version: plan.source_version, plan_sha256: plan.plan_sha256 } });
  const cleanup = f.records.cleanup(command, f.client, { head: async (key) => {
    enter(); await released;
    const asset = plan.assets.find((entry) => entry.object_key === key)!;
    return deleted.includes(key) ? null : { size: asset.length_bytes, etag: asset.put_etag!, version: asset.object_version! };
  }, delete: async (key) => { deleted.push(key); } });
  await entered;
  try { await expect(f.queue.enqueue(f.publication)).rejects.toThrow("unavailable"); }
  finally { release(); }
  const result = await cleanup;
  expect(result.operation.state).toBe("succeeded");
  expect(deleted.sort()).toEqual(plan.assets.map((asset) => asset.object_key).sort());
  expect(f.records.detail(command.operation_id)!.assets.every((asset) => asset.deletion_state === "deleted")).toBe(true);
  const never = { head: async () => { throw new Error("must not replay"); }, delete: async () => { throw new Error("must not replay"); } };
  expect(await f.records.cleanup(command, f.client, never)).toEqual(result);
});

test("partial and unknown deletion outcomes remain observable and are never automatically repeated", async () => {
  const f = fixture(); await f.verified(false); await f.change("cancel");
  const plan = await f.records.cleanupPlan(f.id); let calls = 0;
  const command = operationCommandSchema.parse({ schema_version: 1, ...f.runtime, operation_id: crypto.randomUUID(), request_id: crypto.randomUUID(), expected_version: 0,
    action: "cleanup", cleanup: { source_operation_id: f.id, source_version: plan.source_version, plan_sha256: plan.plan_sha256 } });
  const deleted = new Set<string>();
  const bucket = { head: async (key: string) => {
    const asset = plan.assets.find((entry) => entry.object_key === key)!;
    return deleted.has(key) ? null : { size: asset.length_bytes, etag: asset.put_etag!, version: asset.object_version! };
  }, delete: async (key: string) => { calls++; if (calls === 2) throw new Error("private-secret must not be retained"); deleted.add(key); } };
  const result = await f.records.cleanup(command, f.client, bucket);
  expect(result.request.outcome).toBe("unknown"); expect(result.operation.state).toBe("blocked");
  const detail = f.records.detail(command.operation_id)!;
  expect(detail.assets.map((asset) => asset.deletion_state).sort()).toEqual(["deleted", "unknown"]);
  expect(JSON.stringify(detail)).not.toContain("private-secret");
  await f.records.cleanup(command, f.client, bucket); expect(calls).toBe(2);
});

test("stale cleanup preview and mismatched object identities never delete any object", async () => {
  const f = fixture(); await f.verified(false); await f.change("cancel");
  const plan = await f.records.cleanupPlan(f.id); let deletes = 0;
  const command = operationCommandSchema.parse({ schema_version: 1, ...f.runtime, operation_id: crypto.randomUUID(), request_id: crypto.randomUUID(), expected_version: 0,
    action: "cleanup", cleanup: { source_operation_id: f.id, source_version: plan.source_version, plan_sha256: "d".repeat(64) } });
  const bucket = { head: async () => ({ size: 100, etag: "different", version: "different" }), delete: async () => { deletes++; } };
  await expect(f.records.cleanup(command, f.client, bucket)).rejects.toThrow("preview changed");
  const result = await f.records.cleanup({ ...command, cleanup: { ...command.cleanup!, plan_sha256: plan.plan_sha256 } }, f.client, bucket);
  expect(result.operation.state).toBe("blocked"); expect(deletes).toBe(0);
});

test("bounded pagination preserves all required history and GET diagnosis does not write SQL or schedule an Alarm", async () => {
  const f = fixture(), id = crypto.randomUUID();
  const root = { ...f.register, operation_id: id, request_id: crypto.randomUUID(), assets: undefined,
    operation: operationSpecSchema.parse({ operation_id: id, import_id: id, kind: "rss_import", target_kind: "show", show_id: "daily",
      worker_version_id: f.runtime.worker_version_id, service_config_sha256: f.runtime.service_config_sha256, input_sha256: "d".repeat(64) }) };
  await f.records.command(root, f.client);
  for (let n = 0; n < 45; n++) await f.records.command({ ...root, action: "resume", operation: undefined,
    phase: "step_completed", expected_version: f.records.get(id)!.version, request_id: crypto.randomUUID() }, f.client);
  const before = f.database.query("SELECT total_changes() AS n").get(), alarm = f.alarm();
  const detail = f.records.detail(id)!;
  expect(detail.events).toHaveLength(20); expect(detail.requests).toHaveLength(20);
  expect(f.records.detail(id, detail.next_event_version!, detail.next_request_cursor!)!.events[0]!.operation_version).toBe(21);
  f.records.list(true); f.records.request(root.request_id);
  expect(f.database.query("SELECT total_changes() AS n").get()).toEqual(before); expect(f.alarm()).toBe(alarm);
});

test("capacity warning thresholds and new large import admission leave room for existing operation completion", async () => {
  const f = fixture(); let bytes = 500_000_000;
  Object.defineProperty(f.storage.sql, "databaseSize", { get: () => bytes });
  expect(f.records.capacity().warning).toBe("half"); bytes = 700_000_000; expect(f.records.capacity().warning).toBe("high");
  await f.records.command(f.register, f.client);
  bytes = 999_990_000; expect(f.records.capacity().warning).toBe("critical");
  const id = crypto.randomUUID();
  await expect(f.records.command({ ...f.register, operation_id: id, request_id: crypto.randomUUID(), assets: undefined, estimated_operations: 100,
    operation: operationSpecSchema.parse({ operation_id: id, import_id: id, kind: "rss_import", target_kind: "show", show_id: "daily",
      worker_version_id: f.runtime.worker_version_id, service_config_sha256: f.runtime.service_config_sha256, input_sha256: "d".repeat(64) }) }, f.client)).rejects.toThrow("capacity");
  expect((await f.change("cancel")).operation.state).toBe("cancelled");
});

test("unsupported record format and disabled foreign keys are rejected without replacing existing tables", () => {
  const f = fixture(); f.storage.sql.exec("UPDATE operation_record_schema SET version = 99");
  expect(() => new SqliteOperationRecords(f.storage, () => f.queue.identity())).toThrow("Unsupported");
  expect(f.storage.sql.exec("SELECT version FROM operation_record_schema").toArray()[0]!.version).toBe(99);
  f.database.exec("PRAGMA foreign_keys = OFF");
  expect(() => new SqliteOperationRecords(f.storage, () => f.queue.identity())).toThrow("foreign keys");
});

test("operations HTTP authenticates and bounds input while read-only routes remain available during a pause", async () => {
  const f = fixture(); await f.records.command(f.register, f.client);
  const http = createSqliteOperationHttp(f.records, "key", () => false, { head: async () => null, delete: async () => {} });
  const url = "https://example.com/admin/sqlite-operations/", headers = { "X-Castloop-Key": "key" };
  expect((await http(new Request(`${url}list`))).status).toBe(401);
  expect((await http(new Request(`${url}list?incomplete=true`, { headers }))).status).toBe(200);
  expect((await http(new Request(`${url}list?incomplete=true&incomplete=false`, { headers }))).status).toBe(409);
  expect((await http(new Request(`${url}commands`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }))).status).toBe(503);
  expect((await http(new Request(`${url}requests/${f.register.request_id}`, { headers }))).headers.get("Cache-Control")).toBe("no-store");
});
