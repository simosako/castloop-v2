import { afterEach, expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { SQLITE_DOMAIN_PROTOCOL, sqliteDomainRequestHash } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { parseShowMetadata, stringifyToml } from "@castloop/shared";
import { RSS_IMPORT_AUDIO } from "./test-support/rss-import";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });
async function fixture(shows = ["a", "b"], builtin = false, episodes = 0) {
  const f = await sqliteServiceFixture(); fixtures.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "initial", f.options, { attempts: 2, delay: async () => {} });
  const run = (command: string, args: string[] = []) => runSqliteCommand(f.root, f.config, command, args, { transport: f.transport, cloudflare: f.options });
  for (const id of shows) {
    await run("create-show", builtin ? [id] : [id, "https://example.com"]);
    writeFileSync(join(f.root, id, "cover.jpg"), Uint8Array.of(255, 216, 255));
    if (builtin) {
      const path = join(f.root, id, "show.toml");
      writeFileSync(path, stringifyToml({ ...parseShowMetadata(readFileSync(path, "utf8")), site_css_path: "site.css", site_timezone: "Asia/Tokyo" }));
      writeFileSync(join(f.root, id, "site.css"), ":root{--cl-accent:purple}");
    }
    await run("publish-show", [id]);
    for (let index = 0; index < episodes; index++) {
      const episodeId = `ep-${index}`;
      await run("create-episode", [id, episodeId]);
      writeFileSync(join(f.root, id, "audio.mp3"), RSS_IMPORT_AUDIO);
      await run("publish-episode", [id, episodeId, "audio.mp3"]);
    }
  }
  const target = { ...f.config, public_base_url: "https://podcasts.example.com" };
  const request = { schema_version: 1 as const, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: crypto.randomUUID(), action: "add" as const,
    hostname: "podcasts.example.com", zone_id: "c".repeat(32), zone_name: "example.com", namespace_id: "b".repeat(32),
    previous_config: f.config, previous_config_sha256: await sqliteServiceConfigHash(f.config), target_config: target,
    target_config_sha256: await sqliteServiceConfigHash(target), worker_source_sha256: "d".repeat(64), worker_metadata_sha256: "e".repeat(64) };
  const connection = { id: "f".repeat(32), cert_id: crypto.randomUUID(), hostname: request.hostname, zone_id: request.zone_id,
    zone_name: request.zone_name, service: f.config.worker_name, environment: "production" as const, enabled: true as const, previews_enabled: false as const };
  const deploy = async () => {
    await f.bucket.put("system/service.toml", stringifyToml(target));
    const actual = await f.deployConfiguration(target);
    return { operation_id: request.operation_id, request_sha256: await sqliteDomainRequestHash(request), worker_version_id: actual.worker_version_id,
      deployment_id: crypto.randomUUID(), script_etag: "acknowledged", connection };
  };
  return Object.assign(f, { run, target, request, connection, deploy });
}

test("a committed domain change bumps generations, keeps on-demand rendering and records the connection", async () => {
  const f = await fixture(["a"], true, 21), page = { kind: "listing" as const, showId: "a", page: 1 };
  const beforeGeneration = f.content.inspect("a").show!.feed_generation;
  await f.control.prepareDomain(f.request);
  expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(503);
  const commit = await f.deploy();
  const committed = await f.control.commitDomain(commit);
  expect(committed.phase).toBe("completed"); expect(committed.all_completed).toBe(true);
  const nextGeneration = f.content.inspect("a").show!.feed_generation;
  expect(nextGeneration).toBeGreaterThan(beforeGeneration);
  expect(f.nodes.get("a")!.service.siteDelivery(page)).toMatchObject({ status: 200, props: { generation: nextGeneration } });
  const listing = f.nodes.get("a")!.service.renderSitePage(page)!.html;
  expect(listing).toContain('href="https://podcasts.example.com/podcasts/a/"');
  expect(listing).toContain(":root{--cl-accent:purple}");
  expect(listing).toContain("(UTC+09:00)</time>");
  const siteId = f.content.sites.ids.get("a", "ep-0")!;
  const detail = f.nodes.get("a")!.service.renderSitePage({ kind: "episode", showId: "a", siteId })!.html;
  expect(detail).toContain("(UTC+09:00)</time>");
  await f.control.finalizeDomain({ operation_id: f.request.operation_id, request_sha256: commit.request_sha256, connection: f.connection, detached: false });
  expect(f.control.domainState().connection).toEqual(f.connection);
}, 60000);

for (const shows of [[], ["a"], ["a", "b"]]) test(`domain preparation and commit complete with ${shows.length} Shows and preserve immutable objects`, async () => {
  const f = await fixture(shows);
  const previous = new Map([...f.entries].filter(([key]) => key.includes("/covers/") || key.endsWith(".toml")).map(([key, object]) => [key, object.etag]));
  const prepared = await f.control.prepareDomain(f.request);
  expect(prepared.phase).toBe("prepared");
  for (const id of shows) {
    const node = f.nodes.get(id)!;
    expect(node.service.delivery(`/podcasts/${id}/feed.xml`).status).toBe(503);
    await expect(f.run("publish-show", [id])).rejects.toThrow();
  }
  const commit = await f.deploy();
  const result = await f.control.commitDomain(commit);
  expect(result.phase).toBe("completed"); expect(result.all_completed).toBe(true);
  for (const [key, etag] of previous) if (key !== "system/service.toml") expect(f.entries.get(key)!.etag).toBe(etag);
  for (const id of shows) {
    const node = f.nodes.get(id)!;
    expect(node.service.delivery(`/podcasts/${id}/feed.xml`).status).toBe(200);
    expect(node.service.renderFeed()!.xml).toContain(`https://podcasts.example.com/podcasts/${id}/feed.xml`);
  }
});

test("commit requires its deployed target configuration and never adopts an undeployed request", async () => {
  const f = await fixture(["a"]);
  await f.control.prepareDomain(f.request);
  const commit = { operation_id: f.request.operation_id, request_sha256: await sqliteDomainRequestHash(f.request),
    worker_version_id: crypto.randomUUID(), deployment_id: crypto.randomUUID(), script_etag: "acknowledged", connection: f.connection };
  await expect(f.control.commitDomain(commit)).rejects.toThrow("target configuration");
  expect((await f.control.domainStatus(f.request.operation_id)).phase).toBe("prepared");
});

test("commit receipts are frozen and the same commit can be resent after an unknown outcome", async () => {
  const f = await fixture();
  await f.control.prepareDomain(f.request);
  const commit = await f.deploy();
  f.faults.lostShow = { action: "domain-commit", showId: "a" };
  await expect(f.control.commitDomain(commit)).rejects.toThrow("Unconfirmed");
  f.faults.lostShow = undefined;
  const retried = await f.control.commitDomain(commit);
  expect(retried.phase).toBe("completed");
  await expect(f.control.commitDomain({ ...commit, deployment_id: crypto.randomUUID() })).rejects.toThrow("frozen");
  expect(f.showCalls.filter((call) => call.action === "domain-commit")).toHaveLength(3);
});

test("a failed domain cache purge keeps delivery unavailable until commit succeeds", async () => {
  const f = await fixture(["a"]);
  await f.control.prepareDomain(f.request);
  const commit = await f.deploy();
  const node = f.nodes.get("a")!;
  const generation = node.service.content.inspect("a").show!.feed_generation;
  f.faults.failDomainPurge = "a";
  await expect(f.control.commitDomain(commit)).rejects.toThrow();
  expect(node.service.delivery("/podcasts/a/feed.xml").status).toBe(503);
  expect((await node.service.domainStatus(f.request.operation_id)).phase).toBe("prepared");
  expect(node.service.content.inspect("a").show!.feed_generation).toBe(generation);
  f.faults.failDomainPurge = undefined;
  expect((await f.control.commitDomain(commit)).all_completed).toBe(true);
  expect(node.service.delivery("/podcasts/a/feed.xml").status).toBe(200);
});

test("a lost Show preparation is completed by re-running preparation; new Shows and pending changes are rejected meanwhile", async () => {
  const f = await fixture();
  f.faults.lostShow = { action: "domain-prepare", showId: "b" };
  await expect(f.control.prepareDomain(f.request)).rejects.toThrow("Unconfirmed");
  await expect(f.run("create-show", ["c", "https://example.com"])).rejects.toThrow();
  f.faults.lostShow = undefined;
  const prepared = await f.control.prepareDomain(f.request);
  expect(prepared.phase).toBe("prepared");
  await expect(f.control.prepareDomain({ ...f.request, operation_id: crypto.randomUUID() })).rejects.toThrow();
  expect(f.showCalls.filter((call) => call.action === "domain-prepare")).toHaveLength(4);
});

test("a configuration change without a prepared domain change is refused at boot", async () => {
  const f = await fixture(["a"]);
  await expect(f.deployConfiguration(f.target)).rejects.toThrow("cannot change");
  expect(f.nodes.get("a")!.service.delivery("/podcasts/a/feed.xml").status).toBe(200);
});

test("domain preparation suspends future schedules for explicit reapproval", async () => {
  const f = await fixture(["a"]);
  await f.run("create-episode", ["a", "ep-x"]);
  writeFileSync(join(f.root, "a", "audio.mp3"), RSS_IMPORT_AUDIO);
  const options = { transport: f.transport, cloudflare: f.options,
    scheduleOptions: { at: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, "Z") } };
  const plan = await runSqliteCommand(f.root, f.config, "preview-episode-schedule", ["a", "ep-x", "audio.mp3"], options) as { approval_sha256: string };
  await runSqliteCommand(f.root, f.config, "schedule-episode", ["a", "ep-x", "audio.mp3"], { ...options, expectedPreview: plan.approval_sha256 });
  const node = f.nodes.get("a")!;
  expect(node.service.schedules.summary().scheduled).toBe(1);
  await f.control.prepareDomain(f.request);
  expect(node.service.schedules.summary()).toMatchObject({ scheduled: 0, needs_approval: 1 });
  const rows = f.storage.sql.exec<{ reason_code: string }>("SELECT reason_code FROM publication_schedules WHERE state = 'needs_approval'").toArray();
  expect(rows[0]!.reason_code).toBe("domain_change");
});

test("remove restores workers.dev origins and clears the known connection", async () => {
  const f = await fixture();
  await f.control.prepareDomain(f.request); const added = await f.deploy();
  await f.control.commitDomain(added);
  await f.control.finalizeDomain({ operation_id: f.request.operation_id, request_sha256: added.request_sha256, connection: f.connection, detached: false });
  const remove = { ...f.request, operation_id: crypto.randomUUID(), action: "remove" as const,
    previous_config: f.target, previous_config_sha256: await sqliteServiceConfigHash(f.target), target_config: f.config,
    target_config_sha256: await sqliteServiceConfigHash(f.config), connection: f.connection };
  await f.control.prepareDomain(remove);
  await f.bucket.put("system/service.toml", stringifyToml(f.config));
  const actual = await f.deployConfiguration(f.config);
  const commit = { ...added, operation_id: remove.operation_id, request_sha256: await sqliteDomainRequestHash(remove),
    worker_version_id: actual.worker_version_id, deployment_id: crypto.randomUUID() };
  await f.control.commitDomain(commit);
  const finalized = { operation_id: remove.operation_id, request_sha256: commit.request_sha256, connection: f.connection, detached: true };
  await expect(f.control.finalizeDomain({ ...finalized, detached: false })).rejects.toThrow();
  expect((await f.control.finalizeDomain(finalized)).phase).toBe("completed");
  expect(f.control.domainState().connection).toBeNull();
  for (const id of ["a", "b"]) {
    const node = f.nodes.get(id)!;
    expect(node.service.health()).toMatchObject({ publication_ready: true });
    expect(node.service.content.renderFeed(id, f.config.workers_dev_base_url)!.xml).toContain(`${f.config.workers_dev_base_url}/podcasts/${id}/feed.xml`);
  }
});

test("paged status counts every Show even beyond the first page", async () => {
  const ids = Array.from({ length: 21 }, (_, index) => `show-${String(index).padStart(2, "0")}`);
  const f = await fixture(ids);
  const prepared = await f.control.prepareDomain(f.request);
  expect(prepared.targets).toHaveLength(20); expect(prepared.next_cursor).toBe(ids[19]);
  expect(prepared.all_completed).toBe(false);
  expect(prepared.target_count).toBe(21);
  expect(prepared.targets.every((item) => item.phase === "prepared")).toBe(true);
  const beyond = await f.control.domainStatus(f.request.operation_id, ids[19]);
  expect(beyond.targets).toMatchObject([{ show_id: ids[20], phase: "prepared" }]);
  const commit = await f.deploy();
  const completed = await f.control.commitDomain(commit);
  expect(completed.all_completed).toBe(true);
  expect(await f.control.domainStatus(f.request.operation_id, ids[19])).toMatchObject({ targets: [{ show_id: ids[20], phase: "completed" }] });
});
