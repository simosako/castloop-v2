import { afterEach, expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { SQLITE_DOMAIN_PROTOCOL, sqliteDomainRequestHash } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { stringifyToml } from "@castloop/shared";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });
async function fixture(shows = ["a", "b"]) {
  const f = await sqliteServiceFixture(); fixtures.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "initial", f.options, { attempts: 2, delay: async () => {} });
  const run = (command: string, args: string[] = []) => runSqliteCommand(f.root, f.config, command, args, { transport: f.transport, cloudflare: f.options });
  for (const id of shows) {
    await run("create-show", [id, "https://example.com"]); await run("show-resume", [id, crypto.randomUUID()]);
    writeFileSync(join(f.root, id, "cover.jpg"), Uint8Array.of(255, 216, 255));
    await run("update-show", [id]); await run("publish-show", [id]); await run("show-pause", [id, crypto.randomUUID()]);
  }
  const target = { ...f.config, public_base_url: "https://podcasts.example.com" };
  const request = { schema_version: 1 as const, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: crypto.randomUUID(), action: "add" as const,
    hostname: "podcasts.example.com", zone_id: "c".repeat(32), zone_name: "example.com", namespace_id: "b".repeat(32),
    previous_runtime: f.runtime.queue.identity(), previous_config: f.config, target_config: target,
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

for (const shows of [[], ["a"], ["a", "b"]]) test(`domain configuration activation and Feed regeneration complete paused with ${shows.length} Shows`, async () => {
  const f = await fixture(shows);
  const previous = new Map([...f.entries].filter(([key]) => key.includes("/covers/") || key.endsWith(".toml")).map(([key, object]) => [key, object.etag]));
  const prepared = await f.control.prepareDomain(f.request);
  expect(prepared.phase).toBe("prepared"); expect(prepared.prepared_count).toBe(shows.length);
  for (const id of shows) expect(() => f.nodes.get(id)!.service.queue.resume(crypto.randomUUID())).toThrow();
  const activation = await f.deploy();
  expect((await f.control.domainStatus(f.request.operation_id)).targets_native_ready).toBe(true);
  expect((await f.control.activateDomain(activation)).phase).toBe("probing");
  await f.progressDomains();
  expect((await f.control.domainStatus(f.request.operation_id)).all_completed).toBe(true);
  for (const id of shows) {
    const node = f.nodes.get(id)!;
    expect(node.service.delivery(`/podcasts/${id}/feed.xml`).status).toBe(503);
    const generation = node.service.content.inspect(id).show!.feed_generation;
    expect(f.text(`public/podcasts/${id}/feeds/${generation}.xml`)).toContain(`https://podcasts.example.com/podcasts/${id}/feed.xml`);
    expect(node.service.queue.snapshot().state).toBe("paused");
  }
  const result = await f.control.finalizeDomain({ operation_id: f.request.operation_id, request_sha256: activation.request_sha256, connection: f.connection, detached: false });
  expect(result.phase).toBe("completed"); expect(result.released_count).toBe(shows.length);
  expect(f.control.domainState().connection).toEqual(f.connection);
  for (const [key, etag] of previous) if (key !== "system/service.toml") expect(f.entries.get(key)!.etag).toBe(etag);
  for (const id of shows) { f.nodes.get(id)!.service.queue.resume(crypto.randomUUID()); expect(f.nodes.get(id)!.service.delivery(`/podcasts/${id}/feed.xml`).status).toBe(200); }
});

test("partial preparation freezes membership, rejects code-only updates and never replays a lost Show request", async () => {
  const f = await fixture(); f.faults.lostShow = { action: "domain-prepare", showId: "b" };
  await expect(f.control.prepareDomain(f.request)).rejects.toThrow("Unconfirmed");
  expect((await f.control.domainStatus(f.request.operation_id)).phase).toBe("preparing");
  await expect(f.control.prepareDomain(f.request)).rejects.toThrow();
  await expect(f.run("create-show", ["c", "https://example.com"])).rejects.toThrow();
  await expect(f.control.prepareUpdate({ ...f.request.previous_runtime, operation_id: crypto.randomUUID(),
    namespace_id: "b".repeat(32), worker_source_sha256: "f".repeat(64), worker_metadata_sha256: "f".repeat(64) })).rejects.toThrow();
  expect(f.showCalls.filter((call) => call.action === "domain-prepare")).toHaveLength(2);
});

for (const failure of ["write", "purge"] as const) test(`Feed ${failure} failure blocks the exact domain operation without rewriting or activating later work`, async () => {
  const f = await fixture(["a"]); await f.control.prepareDomain(f.request); const activation = await f.deploy();
  await f.control.activateDomain(activation);
  const node = f.nodes.get("a")!, oldGeneration = node.service.content.inspect("a").show!.feed_generation;
  if (failure === "write") f.hooks.afterPut = async (key) => { if (key.includes("/feeds/")) throw new Error("Lost immutable write response"); };
  else f.faults.failDomainPurge = "a";
  await f.progressDomains(); f.hooks.afterPut = undefined;
  expect((await node.service.domainStatus(f.request.operation_id)).phase).toBe("blocked");
  expect(node.service.content.inspect("a").show!.feed_generation).toBe(oldGeneration);
  const writes = f.bucketCalls.filter((call) => call.method === "PUT").length;
  await f.progressDomains(); expect(f.bucketCalls.filter((call) => call.method === "PUT")).toHaveLength(writes);
  await expect(f.control.activateDomain(activation)).rejects.toThrow();
  await expect(f.control.finalizeDomain({ operation_id: f.request.operation_id, request_sha256: activation.request_sha256, connection: f.connection, detached: false })).rejects.toThrow();
});

test("remove restores workers.dev Feed URLs before finalizing the exact known connection", async () => {
  const f = await fixture(); await f.control.prepareDomain(f.request); const added = await f.deploy();
  await f.control.activateDomain(added); await f.progressDomains();
  await f.control.finalizeDomain({ operation_id: f.request.operation_id, request_sha256: added.request_sha256, connection: f.connection, detached: false });
  const remove = { ...f.request, operation_id: crypto.randomUUID(), action: "remove" as const,
    previous_runtime: f.runtime.queue.identity(), previous_config: f.target, target_config: f.config,
    target_config_sha256: await sqliteServiceConfigHash(f.config), connection: f.connection };
  await f.control.prepareDomain(remove);
  await f.bucket.put("system/service.toml", stringifyToml(f.config));
  const actual = await f.deployConfiguration(f.config);
  const activation = { ...added, operation_id: remove.operation_id, request_sha256: await sqliteDomainRequestHash(remove),
    worker_version_id: actual.worker_version_id, deployment_id: crypto.randomUUID() };
  await f.control.activateDomain(activation); await f.progressDomains();
  const finalized = { operation_id: remove.operation_id, request_sha256: activation.request_sha256, connection: f.connection, detached: true };
  await expect(f.control.finalizeDomain({ ...finalized, detached: false })).rejects.toThrow();
  expect((await f.control.finalizeDomain(finalized)).phase).toBe("completed");
  expect(f.control.domainState().connection).toBeNull();
  for (const id of ["a", "b"]) {
    const node = f.nodes.get(id)!, generation = node.service.content.inspect(id).show!.feed_generation;
    expect(f.text(`public/podcasts/${id}/feeds/${generation}.xml`)).toContain(`${f.config.workers_dev_base_url}/podcasts/${id}/feed.xml`);
    expect(node.service.health()).toMatchObject({ state: "paused", publication_ready: true, maintenance_operation_id: null });
  }
});

test("interrupted domain execution is retained blocked and never resends its Feed write", async () => {
  const f = await fixture(["a"]); await f.control.prepareDomain(f.request); const activation = await f.deploy();
  await f.control.activateDomain(activation);
  f.nodes.get("a")!.fixture.storage.sql.exec("UPDATE publication_domain_changes SET state = 'running'");
  f.restart();
  const writes = f.bucketCalls.filter((call) => call.method === "PUT").length;
  await f.progressDomains();
  expect((await f.nodes.get("a")!.service.domainStatus(f.request.operation_id))).toMatchObject({ phase: "blocked", reason_code: "execution_interrupted" });
  expect(f.bucketCalls.filter((call) => call.method === "PUT")).toHaveLength(writes);
});

test("domain config activation and Alarm reservation roll back atomically on scheduling failure", async () => {
  const f = await fixture(["a"]); await f.control.prepareDomain(f.request); const activation = await f.deploy();
  f.nodes.get("a")!.fixture.failAlarm();
  await expect(f.control.activateDomain(activation)).rejects.toThrow("scheduling");
  const node = f.nodes.get("a")!;
  expect(node.service.queue.identity()).toEqual(f.request.previous_runtime);
  expect((await node.service.domainStatus(f.request.operation_id))).toMatchObject({ phase: "prepared", activation: null });
  await expect(f.control.activateDomain(activation)).rejects.toThrow();
});

test("activation receipt and native version must match every prepared target, and requested activations are not replayed", async () => {
  const f = await fixture(); await f.control.prepareDomain(f.request);
  const activation = await f.deploy();
  await expect(f.control.activateDomain({ ...activation, request_sha256: "f".repeat(64) })).rejects.toThrow();
  f.faults.lostShow = { action: "domain-activate", showId: "a" };
  await expect(f.control.activateDomain(activation)).rejects.toThrow("Unconfirmed");
  await expect(f.control.activateDomain(activation)).rejects.toThrow();
  expect(f.showCalls.filter((call) => call.action === "domain-activate")).toEqual([{ action: "domain-activate", showId: "a" }]);
  expect(f.nodes.get("b")!.service.queue.snapshot().state).toBe("paused");
});
