import { afterEach, expect, test } from "bun:test";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { SqliteOperationClient } from "./sqlite-operation-client";
import { administratorKey } from "./administrator-key";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });

async function fixture() {
  const f = await sqliteServiceFixture(); values.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "source", f.options, { attempts: 2, delay: async () => {} });
  const options = { transport: f.transport, cloudflare: f.options };
  const run = (command: string, args: string[] = []) => runSqliteCommand(f.root, f.config, command, args, options);
  await run("service-resume", [crypto.randomUUID()]); await run("create-show", ["daily", "https://example.com/show"]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  const client = new SqliteOperationClient(f.config, administratorKey(f.root), f.transport);
  return { ...f, options, run, client };
}

test("CLI cancellation, reviewed cleanup and a fresh update retain local originals and immutable operation receipts", async () => {
  const f = await fixture(); await f.run("update-show", ["daily"]);
  const operation = (await f.client.list()).operations.find((entry) => entry.kind === "upload")!;
  const keys = (await f.client.detail(operation.operation_id))!.assets.map((asset) => asset.object_key);
  await f.run("operation-cancel", ["upload", operation.operation_id]);
  const plan = await f.client.cleanupPlan(operation.operation_id);
  expect(plan.assets).toHaveLength(2);
  const before = f.calls.length;
  await expect(f.run("operation-cleanup", ["upload", operation.operation_id, "0".repeat(64), "confirm"])).rejects.toThrow("hash differs");
  expect(f.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
  const result = await f.run("operation-cleanup", ["upload", operation.operation_id, plan.plan_sha256, "confirm"]);
  expect(result).toMatchObject({ operation: { kind: "cleanup", state: "succeeded" } });
  expect(keys.every((key) => !f.entries.has(key))).toBe(true);
  expect(existsSync(join(f.root, "daily", "show.toml"))).toBe(true);
  expect(existsSync(join(f.root, "daily", "cover.jpg"))).toBe(true);
  expect((await f.client.detail(operation.operation_id))!.assets.every((asset) => asset.deletion_state === "deleted")).toBe(true);
  expect(f.text("public/podcasts/daily/feed.xml")).toBe("");
  await f.run("update-show", ["daily"]); expect(await f.run("publish-show", ["daily"])).toMatchObject({ state: "succeeded" });
  expect(keys.every((key) => !f.entries.has(key))).toBe(true);
  expect((await f.client.detail(operation.operation_id))!.operation.state).toBe("cancelled");
});

test("CLI local and remote status leave all journals and SQL rows unchanged even with a retained legacy lock", async () => {
  const f = await fixture(); await f.run("update-show", ["daily"]);
  const upload = (await f.client.list()).operations.find((entry) => entry.kind === "upload")!;
  const file = join(f.root, ".castloop", "sqlite-uploads", f.config.service_id, `${upload.operation_id}.json`);
  writeFileSync(`${file}.lock`, "");
  const snapshot = () => readdirSync(join(f.root, ".castloop"), { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".json") || name.endsWith(".lock"))
    .sort().map((name) => [name, readFileSync(join(f.root, ".castloop", name), "utf8")]);
  const before = snapshot(), changes = f.database.query("SELECT total_changes() n").get();
  const local = await runSqliteCommand(f.root, f.config, "operation-status", ["upload", upload.operation_id], { operationOptions: { local: true } });
  expect(local).toMatchObject({ source: "local", operations: [{ legacy_lock_present: true }] });
  expect(await f.run("operation-status", ["upload", upload.operation_id])).toMatchObject({ operation: { state: "succeeded" } });
  expect(snapshot()).toEqual(before); expect(f.database.query("SELECT total_changes() n").get()).toEqual(changes);
});
