import { afterEach, expect, test } from "bun:test";
import { initializeSqliteService, readSqliteInitialization, reconcileSqliteInitialization } from "./sqlite-initialization";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
async function fixture() { const value = await sqliteServiceFixture(); values.push(value); return value; }
const wait = { attempts: 2, delay: async () => {} };

test("fresh initialization provisions only R2/Worker/SQLite, verifies native runtime probes and finishes paused", async () => {
  const value = await fixture(), id = crypto.randomUUID();
  const state = await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait);
  expect(state.phase).toBe("ready"); expect(state.namespace_id).toBe("b".repeat(32));
  expect(value.runtime.health()).toMatchObject({ publication_ready: true, state: "paused", drained: true });
  expect(value.calls.some((call) => /queues|event_notifications|d1/.test(call.path))).toBe(false);
  const metadata = value.metadata()!;
  expect(metadata.exports).toMatchObject({ default: { cache: { enabled: false } }, SqliteCachedAssets: { cache: { enabled: true } },
    SqlitePublicationService: { type: "durable-object", storage: "sqlite" } });
  const source = readFileSync(join(value.root, ".castloop", "sqlite-initializations", value.config.service_id, "initialize.json"), "utf8");
  expect(source).not.toContain("private-token"); expect(source).not.toContain("CASTLOOP_ADMIN_KEY"); expect(source).not.toContain("worker source");
  expect(readFileSync(join(value.root, ".gitignore"), "utf8")).toContain(".castloop/");
  expect(readFileSync(join(value.root, ".gitignore"), "utf8")).toContain("*.mp3");
  const calls = value.calls.length;
  expect((await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait)).phase).toBe("ready");
  expect(value.calls.length).toBe(calls);
});

for (const phase of ["bucket", "config", "worker", "deploy", "access"] as const) {
  test(`unknown ${phase} outcome is retained and initialization never replays it`, async () => {
    const value = await fixture(), id = crypto.randomUUID(); value.faults.lost = phase;
    await expect(initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait)).rejects.toThrow();
    const state = readSqliteInitialization(value.root, value.config)!;
    expect(state.phase).toBe(`${phase}_requested`);
    const calls = value.calls.length; value.faults.lost = undefined;
    await expect(initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait)).rejects.toThrow("already started");
    expect(value.calls.length).toBe(calls);
    await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow("frozen identity");
    expect(readdirSync(join(value.root, ".castloop", "sqlite-initializations", value.config.service_id))).toEqual(["initialize.json"]);
  });
}

test("a lost setup response is reconciled by exact read-only status, never by another POST", async () => {
  const value = await fixture(), id = crypto.randomUUID(); value.faults.lost = "setup";
  expect((await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait)).phase).toBe("ready");
  expect(value.calls.filter((call) => call.method === "POST" && call.path.endsWith("/prepare"))).toHaveLength(1);
  value.calls.length = 0;
  expect((await reconcileSqliteInitialization(value.root, value.config, id, value.options)).phase).toBe("ready");
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});

for (const fault of ["namespace", "settings"] as const) {
  test(`mismatched ${fault} prevents runtime readiness submission`, async () => {
    const value = await fixture(); value.faults[fault] = true;
    await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow();
    expect(value.calls.some((call) => call.path.endsWith("/prepare"))).toBe(false);
    expect(value.runtime.ready()).toBe(false);
  });
}

test("runtime probe failure never becomes ready and is not bypassed by reconcile", async () => {
  const value = await fixture(), id = crypto.randomUUID(); value.faults.failPurge = true;
  await expect(initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait)).rejects.toThrow("blocked");
  expect(readSqliteInitialization(value.root, value.config)?.phase).toBe("setup_requested");
  const count = value.calls.length;
  await expect(reconcileSqliteInitialization(value.root, value.config, id, value.options)).rejects.toThrow("completion");
  expect(value.calls.slice(count).every((call) => call.method === "GET")).toBe(true);
});

test("deployment metadata does not introduce migrations, Queue resources, secrets in config or paid limits", async () => {
  const value = await fixture(), metadata = buildSqliteWorkerMetadata(value.config, "private-key");
  expect("migrations" in metadata).toBe(false); expect("limits" in metadata).toBe(false);
  expect(new Set<string>(metadata.bindings.map((binding) => binding.type)).has("queue")).toBe(false);
  expect(JSON.stringify(value.config)).not.toContain("private-key");
});

for (const existing of ["bucket", "worker", "empty"] as const) {
  test(`fresh initialization rejects ${existing} resource evidence without starting any mutation`, async () => {
    const value = await fixture(); value.faults.existing = existing;
    await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow();
    expect(value.calls.every((call) => call.method === "GET")).toBe(true);
    expect(readSqliteInitialization(value.root, value.config)?.phase).toBe("prepared");
  });
}

test("a forged ready phase without deployment and namespace evidence is never accepted", async () => {
  const value = await fixture(); value.faults.existing = "bucket";
  await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow();
  const file = join(value.root, ".castloop", "sqlite-initializations", value.config.service_id, "initialize.json");
  const record = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...record, phase: "ready" }));
  expect(() => readSqliteInitialization(value.root, value.config)).toThrow("deployment evidence");
});

test("a symlink gitignore is never followed and prevents secret creation or remote provisioning", async () => {
  const value = await fixture(), outside = join(value.root, "outside-ignore");
  writeFileSync(outside, "user-owned-file\n"); symlinkSync(outside, join(value.root, ".gitignore"));
  await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow();
  expect(readFileSync(outside, "utf8")).toBe("user-owned-file\n");
  expect(existsSync(join(value.root, ".castloop", "secrets.json"))).toBe(false);
  expect(value.calls).toEqual([]);
});
