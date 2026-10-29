import { afterEach, expect, test } from "bun:test";
import { initializeSqliteService, readSqliteInitialization } from "./sqlite-initialization";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { buildSqliteWorkerMetadata } from "../../shared/src/sqlite-worker-deployment";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
async function fixture() { const value = await sqliteServiceFixture(); values.push(value); return value; }
const wait = { attempts: 2, delay: async () => {} };
const unrelatedResourcePath = /\/(?:queues|event_notifications|d1)(?:\/|$)/;

test("resource path checks distinguish D1 endpoints from deployment UUIDs", () => {
  expect(unrelatedResourcePath.test("/accounts/account/workers/scripts/worker/versions/00000000-0000-4000-8000-0000000000d1")).toBe(false);
  for (const path of ["/accounts/account/d1/database", "/accounts/account/queues/queue-id", "/accounts/account/r2/buckets/bucket/event_notifications"]) {
    expect(unrelatedResourcePath.test(path)).toBe(true);
  }
});

test("fresh initialization provisions only R2/Worker/SQLite and finishes immediately ready", async () => {
  const value = await fixture(), id = crypto.randomUUID();
  const state = await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait);
  expect(state.phase).toBe("ready"); expect(state.namespace_id).toBe("b".repeat(32));
  expect(value.runtime.health()).toMatchObject({ publication_ready: true });
  expect(value.calls.some((call) => unrelatedResourcePath.test(call.path))).toBe(false);
  expect(value.calls).toContainEqual({ method: "GET", path: `/r2/buckets/${value.config.bucket_name}` });
  expect(value.calls).toContainEqual({ method: "PUT", path: `/workers/scripts/${value.config.worker_name}?bindings_inherit=strict` });
  expect(value.calls).toContainEqual({ method: "GET", path: `/workers/scripts/${value.config.worker_name}/versions/${state.receipt!.worker_version_id}` });
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
  test(`interrupted ${phase} step completes idempotently on re-running init`, async () => {
    const value = await fixture(), id = crypto.randomUUID(); value.faults.lost = phase;
    await expect(initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait)).rejects.toThrow();
    value.faults.lost = undefined;
    await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow("frozen identity");
    const completed = await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait);
    expect(completed.phase).toBe("ready");
  });
}

for (const fault of ["namespace", "settings"] as const) {
  test(`mismatched ${fault} prevents initialization`, async () => {
    const value = await fixture(); value.faults[fault] = true;
    await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow();
    expect(readSqliteInitialization(value.root, value.config)?.phase).not.toBe("ready");
  });
}

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
    expect(readSqliteInitialization(value.root, value.config)?.phase).toBe("fresh");
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

test("a changed worker source is refused before any remote mutation of a retained initialization", async () => {
  const value = await fixture(), id = crypto.randomUUID(); value.faults.lost = "access";
  await expect(initializeSqliteService(value.root, value.config, id, "source", value.options, wait)).rejects.toThrow();
  const calls = value.calls.length; value.faults.lost = undefined;
  await expect(initializeSqliteService(value.root, value.config, id, "changed", value.options, wait)).rejects.toThrow("frozen identity");
  expect(value.calls.length).toBe(calls);
  expect((await initializeSqliteService(value.root, value.config, id, "source", value.options, wait)).phase).toBe("ready");
});

test("a symlink gitignore is never followed and prevents secret creation or remote provisioning", async () => {
  const value = await fixture(), outside = join(value.root, "outside-ignore");
  writeFileSync(outside, "user-owned-file\n"); symlinkSync(outside, join(value.root, ".gitignore"));
  await expect(initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, wait)).rejects.toThrow();
  expect(readFileSync(outside, "utf8")).toBe("user-owned-file\n");
  expect(existsSync(join(value.root, ".castloop", "secrets.json"))).toBe(false);
  expect(value.calls).toEqual([]);
});

test("private-state ignore rules override earlier negations without rewriting user rules or growing on repeated init", async () => {
  const value = await fixture(), id = crypto.randomUUID(), file = join(value.root, ".gitignore");
  const original = "user-file\n.castloop/\n!.castloop/\n*.mp3\n!*.mp3\n";
  writeFileSync(file, original);
  await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait);
  const protectedSource = readFileSync(file, "utf8");
  expect(protectedSource).toBe(`${original}.castloop/\n*.mp3\n`);
  expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: value.root }).exitCode).toBe(0);
  const ignored = Bun.spawnSync(["git", "check-ignore", "--", ".castloop/secrets.json", "sample.mp3"], { cwd: value.root });
  expect(ignored.exitCode).toBe(0); expect(ignored.stdout.toString().trim().split("\n")).toEqual([".castloop/secrets.json", "sample.mp3"]);
  await initializeSqliteService(value.root, value.config, id, "worker source", value.options, wait);
  expect(readFileSync(file, "utf8")).toBe(protectedSource);
});

test("real-shaped settings without exports are verified against mandatory pinned-version exports", async () => {
  const value = await fixture();
  expect((await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "source", value.options, wait)).phase).toBe("ready");
  const missing = await fixture(); missing.faults.missingVersionExports = true;
  await expect(initializeSqliteService(missing.root, missing.config, crypto.randomUUID(), "source", missing.options, wait)).rejects.toThrow();
  expect(readSqliteInitialization(missing.root, missing.config)?.phase).not.toBe("ready");
});
