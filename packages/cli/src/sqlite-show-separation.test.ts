import { afterEach, expect, spyOn, test } from "bun:test";
import { runSqliteCommand } from "./sqlite-commands";
import { initializeSqliteService } from "./sqlite-initialization";
import { deploySqliteService } from "./sqlite-service-deploy";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { parseSqliteDirectPublicationRequest } from "../../shared/src/sqlite-direct-publication";
import { directShow, directCover } from "../../../src/test-support/direct-publication";
import { administratorKey } from "./administrator-key";
import { formatSqliteCatalog } from "./sqlite-catalog";
import { sqliteCatalogResponseSchema } from "../../shared/src/sqlite-catalog";
import { SqliteServiceControl } from "../../../src/sqlite-service-control";
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
    expect(await run("show-status", [id])).toMatchObject({ scope: "show", show_id: id, publication_ready: true });
    writeFileSync(join(f.root, id, "cover.jpg"), Uint8Array.of(255, 216, 255));
  };
  const deploy = () => deploySqliteService(f.root, f.config, "updated", f.options, wait);
  return Object.assign(f, { run, create, deploy });
}

test("a failed Show publication does not stop another Show's publication, delivery or new registration", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  f.hooks.afterPut = async (key) => { if (key.startsWith("public/podcasts/a/covers/")) throw new Error("Unknown publication write response"); };
  await expect(f.run("publish-show", ["a"])).rejects.toThrow();
  f.hooks.afterPut = undefined;
  expect(await f.run("publish-show", ["b"])).toMatchObject({ result: "changed" });
  const a = f.nodes.get("a")!, b = f.nodes.get("b")!;
  expect(a.service.delivery("/podcasts/a/feed.xml").status).toBe(404);
  expect(b.service.delivery("/podcasts/b/feed.xml").status).toBe(200);
  expect(a.fixture.storage).not.toBe(b.fixture.storage);
  expect(a.fixture.storage.sql.exec("SELECT show_id FROM publication_shows").toArray()).toEqual([{ show_id: "a" }]);
  expect(b.fixture.storage.sql.exec("SELECT show_id FROM publication_shows").toArray()).toEqual([{ show_id: "b" }]);
  await f.create("c");
  expect(await f.run("publish-show", ["c"])).toMatchObject({ result: "changed" });
});

test("the service Show catalog lists Shows without any aggregated availability state", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  expect(await f.run("service-status")).toMatchObject({ scope: "service", show_count: 2, publication_ready: true });
  const result = sqliteCatalogResponseSchema.parse(await f.run("list-shows"));
  expect(result.shows).toHaveLength(2);
  expect(formatSqliteCatalog(result)).toStartWith(`Service: ${f.config.service_id}\n`);
  const episodes = sqliteCatalogResponseSchema.parse(await f.run("list-episodes", ["a"]));
  expect(formatSqliteCatalog(episodes)).not.toContain("Show admission");
});

for (const kind of ["health", "catalog"] as const) for (const failure of [false, true])
  test(`service ${kind} bounds read concurrency and settles its batch before ${failure ? "failure" : "success"}`, async () => {
    const f = await fixture();
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (const id of ids) await f.run("create-show", [id, "https://example.com"]);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), aFailed = Promise.withResolvers<void>();
    const started: string[] = []; let active = 0, maximum = 0, finished = false;
    const read = async (id: string) => {
      started.push(id); active++; maximum = Math.max(maximum, active);
      if (started.length === 4) entered.resolve();
      try {
        if (failure && id === "a") { await entered.promise; aFailed.resolve(); throw new Error("Show read unverified"); }
        await release.promise;
      } finally { active--; }
    };
    const unexpected = async (): Promise<never> => { throw new Error("Read must not mutate Shows"); };
    const control = new SqliteServiceControl(f.controlStorage, f.runtime, (id) => ({
      initialize: unexpected,
      prepareDomain: unexpected, commitDomain: unexpected, domainStatus: unexpected,
      async health() { await read(id); return f.nodes.get(id)!.service.health(); },
      async catalog(request) { await read(id); return f.nodes.get(id)!.service.runtime.catalog(request); },
    }));
    const ownHealth = spyOn(f.runtime, "health");
    const pending = (kind === "health" ? control.health() : control.catalog({ kind: "show", include_deleted: false }))
      .then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })).finally(() => { finished = true; });
    try {
      await entered.promise;
      if (failure) await aFailed.promise;
      expect(started).toEqual(ids.slice(0, 4)); expect(finished).toBe(false); expect(maximum).toBe(4);
      release.resolve(); const result = await pending;
      expect(result.ok).toBe(!failure); expect(active).toBe(0); expect(maximum).toBe(4);
      expect(started).toEqual(failure ? ids.slice(0, 4) : ids);
      if (kind === "health") expect(ownHealth).toHaveBeenCalledTimes(1);
      if (!failure && kind === "catalog" && result.ok) expect(sqliteCatalogResponseSchema.parse(result.value).shows?.map((show) => show.show_id)).toEqual(ids);
    } finally { release.resolve(); await pending; ownHealth.mockRestore(); }
  });

test("separate Shows progress concurrently while one Show awaits external IO and keep delivery gates independent", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  const entered = Promise.withResolvers<void>(), settle = Promise.withResolvers<void>();
  f.hooks.beforePut = async (key) => {
    if (key.startsWith("public/podcasts/a/covers/")) { entered.resolve(); await settle.promise; }
  };
  const pending = f.run("publish-show", ["a"]);
  try {
    await entered.promise;
    expect(await f.run("publish-show", ["b"])).toMatchObject({ result: "changed" });
    expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(404);
    expect(f.nodes.get("b")!.service.delivery("/podcasts/b/feed.xml").status).toBe(200);
  } finally { settle.resolve(); await pending; }
  expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(200);
});

test("Show identities and operation targets cannot cross independent storages", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  const a = f.nodes.get("a")!.service, b = f.nodes.get("b")!.service;
  const identity = a.queue.identity();
  const request = parseSqliteDirectPublicationRequest({ service_id: identity.service_id, service_config_sha256: identity.service_config_sha256,
    schema_version: 1, protocol: "sqlite-sequential-v1", action: "publish", kind: "show",
    show_id: "b", metadata: { ...directShow, show_id: "b" }, cover: directCover, expected_show_state_version: 0 });
  await expect(a.queue.publish(request)).rejects.toThrow("target_unavailable");
  expect(a.delivery("/podcasts/b/feed.xml").status).toBe(404);
  expect(a.content.inspect("b").show).toBe(null);
  const response = await a.fetch(new Request(`${f.config.workers_dev_base_url}/admin/sqlite-service/pause`, {
    method: "POST", headers: { "X-Castloop-Key": administratorKey(f.root), "X-Castloop-Show-Id": "b", "Content-Type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(400);
  expect(await f.run("service-status")).toMatchObject({ scope: "service", show_count: 2, publication_ready: true });
});

test("a code-only deploy keeps Shows serving, publishing and scheduling without any pause ritual", async () => {
  const f = await fixture(); await f.create("a"); await f.create("b");
  await f.run("publish-show", ["a"]); await f.run("publish-show", ["b"]);
  const before = new Map([...f.entries].map(([key, entry]) => [key, entry.etag]));
  const previousVersion = f.runtime.queue.identity().worker_version_id;
  const result = await f.deploy();
  expect(result).toMatchObject({ previous_worker_version_id: previousVersion, publication_ready: true });
  for (const id of ["a", "b"]) {
    const node = f.nodes.get(id)!;
    expect(node.service.delivery(`/podcasts/${id}/feed.xml`).status).toBe(200);
    expect(node.service.health()).toMatchObject({ publication_ready: true });
  }
  expect(await f.run("publish-show", ["a"])).toMatchObject({ result: "unchanged" });
  for (const [key, etag] of before) expect(f.entries.get(key)!.etag).toBe(etag);
  await f.create("c");
  expect(await f.run("publish-show", ["c"])).toMatchObject({ result: "changed" });
});

test("a deploy with a changed configuration is refused and belongs to the domain procedure", async () => {
  const f = await fixture(); await f.create("a"); await f.run("publish-show", ["a"]);
  const changed = { ...f.config, public_base_url: "https://podcasts.example.com" };
  await expect(deploySqliteService(f.root, changed, "updated", f.options, wait)).rejects.toThrow("domain change procedure");
  expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(200);
});

test("an interrupted Show initialization does not block another Show and completes idempotently on retry", async () => {
  const f = await fixture(); f.faults.lostShow = { action: "initialize", showId: "a" };
  await expect(f.run("create-show", ["a", "https://example.com"])).rejects.toThrow();
  expect(f.control.registrationStatus("a").state).toBe("requested");
  f.faults.lostShow = undefined;
  await f.create("b"); expect(await f.run("publish-show", ["b"])).toMatchObject({ result: "changed" });
  await f.create("a"); expect(await f.run("publish-show", ["a"])).toMatchObject({ result: "changed" });
  expect(f.control.registrationStatus("a").state).toBe("registered");
});
