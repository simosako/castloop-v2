import { afterEach, expect, test } from "bun:test";
import { runSqliteCommand } from "./sqlite-commands";
import { initializeSqliteService } from "./sqlite-initialization";
import { continueSqliteServiceUpdateVerification, readSqliteServiceUpdate, reconcileSqliteServiceUpdate, updateSqliteService } from "./sqlite-service-update";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { sqlitePublicationRequest } from "../../../src/test-support/sqlite-publication";
import { SqliteServiceClient } from "./sqlite-service-client";
import { administratorKey } from "./administrator-key";
import { formatSqliteCatalog } from "./sqlite-catalog";
import { sqliteCatalogResponseSchema } from "../../shared/src/sqlite-catalog";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const wait = { attempts: 2, delay: async () => {} };
async function fixture() {
  const f = await sqliteServiceFixture(); fixtures.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "initial", f.options, wait);
  const run = (command: string, args: string[] = []) => runSqliteCommand(f.root, f.config, command, args, { transport: f.transport, cloudflare: f.options });
  const create = async (id: string) => {
    await run("create-show", [id, "https://example.com"]);
    expect(await run("show-status", [id])).toMatchObject({ scope: "show", show_id: id, state: "paused", publication_ready: true });
    await run("show-resume", [id, crypto.randomUUID()]);
    writeFileSync(join(f.root, id, "cover.jpg"), Uint8Array.of(255, 216, 255));
    await run("update-show", [id]);
  };
  const pause = async (id: string) => { await run("show-pause", [id, crypto.randomUUID()]); };
  const update = (id = crypto.randomUUID()) => updateSqliteService(f.root, f.config, id, "updated", f.options, wait);
  return Object.assign(f, { run, create, pause, update });
}

test("a blocked Show does not stop another Show's publication, independent Resume, delivery or new registration", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  f.hooks.afterPut = async (key) => { if (key.startsWith("public/podcasts/a/feeds/")) throw new Error("Unknown publication write response"); };
  await expect(f.run("publish-show", ["a"])).rejects.toThrow("blocked");
  f.hooks.afterPut = undefined;
  expect(await f.run("publish-show", ["b"])).toMatchObject({ state: "succeeded" });
  const a = f.nodes.get("a")!, b = f.nodes.get("b")!;
  expect(a.service.delivery("/podcasts/a/feed.xml").status).toBe(503);
  expect(b.service.delivery("/podcasts/b/feed.xml").status).toBe(200);
  expect(a.fixture.storage).not.toBe(b.fixture.storage);
  expect(a.fixture.storage.sql.exec("SELECT show_id FROM publication_shows").toArray()).toEqual([{ show_id: "a" }]);
  expect(b.fixture.storage.sql.exec("SELECT show_id FROM publication_shows").toArray()).toEqual([{ show_id: "b" }]);
  await f.pause("a"); await f.pause("b");
  expect(b.service.delivery("/podcasts/b/feed.xml").status).toBe(503);
  await f.run("show-resume", ["b", crypto.randomUUID()]);
  expect(b.service.delivery("/podcasts/b/feed.xml").status).toBe(200);
  await expect(f.run("show-resume", ["a", crypto.randomUUID()])).rejects.toThrow();
  await f.create("c");
  expect(await f.run("publish-show", ["c"])).toMatchObject({ state: "succeeded" });
  expect(a.service.queue.snapshot()).toMatchObject({ state: "paused", active: { state: "blocked" }, drained: false });
  await f.pause("b"); await f.pause("c");
  const puts = f.calls.filter((call) => call.method === "PUT").length;
  await expect(f.update()).rejects.toThrow("pause and drain");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
  expect(f.showCalls.filter((call) => call.action === "prepare")).toEqual([]);
});

test("the service Show catalog never claims an aggregated pause state for open, mixed or paused Shows", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  for (const paused of [0, 1, 2]) {
    if (paused) await f.pause(paused === 1 ? "a" : "b");
    expect(await f.run("service-status")).toMatchObject({ state: paused === 2 ? "paused" : "open", paused_shows: paused });
    const result = sqliteCatalogResponseSchema.parse(await f.run("list-shows"));
    expect(result.state).toBeNull(); expect(result.shows).toHaveLength(2);
    expect(formatSqliteCatalog(result)).toStartWith(`Service: ${f.config.service_id}\n`);
    expect(formatSqliteCatalog(result)).not.toContain("(paused)");
    expect(formatSqliteCatalog(result)).not.toContain("(open)");
  }
  const episodes = sqliteCatalogResponseSchema.parse(await f.run("list-episodes", ["a"]));
  expect(episodes.state).toBe("paused"); expect(formatSqliteCatalog(episodes)).toContain("Show admission: paused");
  expect(sqliteCatalogResponseSchema.safeParse({ ...episodes, state: null }).success).toBe(false);
});

test("separate Alarms progress concurrently while one Show awaits external IO and keep delivery gates independent", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  const entered = Promise.withResolvers<void>(), settle = Promise.withResolvers<void>();
  f.hooks.beforePut = async (key) => {
    if (key.startsWith("public/podcasts/a/feeds/")) { entered.resolve(); await settle.promise; }
  };
  const pending = f.run("publish-show", ["a"]);
  try {
    await entered.promise;
    expect(f.nodes.get("a")!.service.queue.snapshot().active?.state).toBe("running");
    expect(await f.run("publish-show", ["b"])).toMatchObject({ state: "succeeded" });
    expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(503);
    expect(f.nodes.get("b")!.service.delivery("/podcasts/b/feed.xml").status).toBe(200);
  } finally { settle.resolve(); await pending; }
  expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(200);
});

test("Show identity, admission windows and operation targets cannot cross independent storages", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  const a = f.nodes.get("a")!.service, b = f.nodes.get("b")!.service;
  const request = sqlitePublicationRequest(a.queue.identity(), a.queue.snapshot().admission_window_id!, { show_id: "b", kind: "show" });
  await expect(a.queue.enqueue(request)).rejects.toThrow("scope");
  await expect(b.queue.enqueue(request)).rejects.toThrow("window");
  expect(a.delivery("/podcasts/b/feed.xml").status).toBe(404);
  expect(a.content.inspect("b").show).toBe(null);
  const response = await a.fetch(new Request(`${f.config.workers_dev_base_url}/admin/sqlite-service/resume`, {
    method: "POST", headers: { "X-Castloop-Key": administratorKey(f.root), "X-Castloop-Show-Id": "b", "Content-Type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(400);
  expect(await f.run("service-status")).toMatchObject({ scope: "service", admission_window_id: null, show_count: 2, paused_shows: 0 });
  await expect(f.run("service-pause", [crypto.randomUUID()])).rejects.toThrow("no legacy fallback");
});

test("a shared update pins both Shows, preserves content and releases Resume only after every probe", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  await f.run("publish-show", ["a"]); await f.run("publish-show", ["b"]);
  const before = new Map([...f.entries].map(([key, entry]) => [key, entry.etag]));
  await f.pause("a"); await f.pause("b");
  f.faults.deferUpdateProbe = true;
  const id = crypto.randomUUID();
  await expect(f.update(id)).rejects.toThrow("remains unconfirmed");
  const a = f.nodes.get("a")!.service, b = f.nodes.get("b")!.service;
  await f.runtime.alarm(); await a.alarmRuntime().alarm(); await f.control.progress();
  expect((await f.control.health()).publication_ready).toBe(false);
  expect(a.health().publication_ready).toBe(false);
  expect(f.showCalls.filter((call) => call.action === "release")).toEqual([]);
  await expect(f.run("show-resume", ["a", crypto.randomUUID()])).rejects.toThrow();
  await expect(f.run("create-show", ["c", "https://example.com"])).rejects.toThrow();
  await b.alarmRuntime().alarm(); await f.control.progress();
  expect(await f.control.health()).toMatchObject({ publication_ready: true, state: "paused", show_count: 2, paused_shows: 2 });
  expect(f.showCalls.filter((call) => call.action === "release")).toHaveLength(2);
  for (const [key, etag] of before) expect(f.entries.get(key)!.etag).toBe(etag);
  expect((await reconcileSqliteServiceUpdate(f.root, f.config, id, f.options)).phase).toBe("ready");
  await f.run("show-resume", ["b", crypto.randomUUID()]);
  expect(b.delivery("/podcasts/b/feed.xml").status).toBe(200);
  expect(a.delivery("/podcasts/a/feed.xml").status).toBe(503);
});

test("Resume racing shared preparation cannot slip between the paused check and the durable Show lock", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  await f.pause("a"); await f.pause("b");
  const reached = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
  const puts = f.calls.filter((call) => call.method === "PUT").length;
  f.faults.beforeShowPrepare = async (id) => { if (id === "b") { reached.resolve(); await proceed.promise; } };
  const pending = f.update();
  try {
    await reached.promise;
    await expect(f.run("show-resume", ["a", crypto.randomUUID()])).rejects.toThrow();
    await f.run("show-resume", ["b", crypto.randomUUID()]);
  } finally { proceed.resolve(); }
  await expect(pending).rejects.toThrow();
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
  expect(f.controlStorage.sql.exec("SELECT phase FROM service_show_maintenance").toArray()).toEqual([{ phase: "preparing" }]);
});

for (const action of ["prepare", "activate", "release"] as const) {
  test(`unknown Show ${action} outcomes retain the exact target record and are never replayed`, async () => {
    const f = await fixture(); await f.create("a"); await f.create("b");
    await f.pause("a"); await f.pause("b");
    f.faults.lostShow = { action, showId: "a" };
    const id = crypto.randomUUID(); await expect(f.update(id)).rejects.toThrow();
    const count = f.showCalls.filter((call) => call.action === action).length;
    expect(count).toBe(1);
    f.faults.lostShow = undefined;
    await f.control.progress(); await f.control.progress();
    await expect(f.update(id)).rejects.toThrow("already started");
    expect(f.showCalls.filter((call) => call.action === action)).toHaveLength(count);
    const column = action === "prepare" ? "prepare_state" : action === "activate" ? "activate_state" : "release_state";
    expect(f.controlStorage.sql.exec(`SELECT ${column} AS state FROM service_show_update_targets WHERE show_id = 'a'`).toArray()).toEqual([{ state: "requested" }]);
    expect((await new SqliteServiceClient(f.config, administratorKey(f.root), f.transport).registrationHealth()).publication_ready).toBe(false);
  });
}

test("an unknown Show initialization keeps its reservation and does not block a different new Show", async () => {
  const f = await fixture(); f.faults.lostShow = { action: "initialize", showId: "a" };
  await expect(f.run("create-show", ["a", "https://example.com"])).rejects.toThrow();
  f.faults.lostShow = undefined;
  await expect(f.run("create-show", ["a", "https://example.com"])).rejects.toThrow("uncertain");
  expect(f.showCalls.filter((call) => call.action === "initialize" && call.showId === "a")).toHaveLength(1);
  expect(f.control.registrationStatus("a").state).toBe("requested");
  await f.create("b"); expect(await f.run("publish-show", ["b"])).toMatchObject({ state: "succeeded" });
  await f.pause("b"); await expect(f.update()).rejects.toThrow("pause and drain");
  expect(f.showCalls.filter((call) => call.action === "prepare")).toEqual([]);
});

test("durability failure before shared fan-out prevents all Show mutations and deployment", async () => {
  const f = await fixture(); await f.create("a"); await f.pause("a");
  const puts = f.calls.filter((call) => call.method === "PUT").length;
  f.failSync(); await expect(f.update()).rejects.toThrow();
  expect(f.showCalls.filter((call) => call.action === "prepare")).toEqual([]);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
  expect(f.controlStorage.sql.exec("SELECT phase FROM service_show_maintenance").toArray()).toEqual([{ phase: "preparing" }]);
  await f.control.progress();
  expect(f.showCalls.filter((call) => call.action === "prepare")).toEqual([]);
});

test("a new control runtime waits for every prepared Show's native version before first activation", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b"); await f.pause("a"); await f.pause("b");
  const id = crypto.randomUUID(); f.faults.staleShowVersion = "b";
  await expect(f.update(id)).rejects.toThrow("continue verification");
  expect(readSqliteServiceUpdate(f.root, f.config, id)!.phase).toBe("verified");
  expect(f.showCalls.filter((call) => call.action === "activate")).toEqual([]);
  const puts = f.calls.filter((call) => call.method === "PUT").length;
  f.faults.staleShowVersion = undefined;
  expect((await continueSqliteServiceUpdateVerification(f.root, f.config, id, "updated", f.options, wait)).phase).toBe("ready");
  expect(f.showCalls.filter((call) => call.action === "activate")).toHaveLength(2);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
});
