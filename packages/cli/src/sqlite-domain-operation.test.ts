import { afterEach, expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { initializeSqliteService } from "./sqlite-initialization";
import { continueSqliteDomainChange, listSqliteDomains, sqliteDomainOperationStatus, startSqliteDomainChange } from "./sqlite-domain-operation";
import { readSqliteDomainJournal } from "./sqlite-domain-journal";
import { loadWorkspaceConfig } from "./workspace-config";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { administratorKey } from "./administrator-key";
import { updateSqliteService } from "./sqlite-service-update";
import { runSqliteCommand } from "./sqlite-commands";
import { readSqliteDraftRecord } from "./sqlite-draft-journal";
import { sqliteLifecyclePlanSchema } from "./sqlite-lifecycle";
import { sqliteFeedSnapshotKey } from "../../../src/sqlite-feed";
import { diagnoseLocal } from "./doctor";
import { readFileSync, writeFileSync } from "node:fs";
import { stringifyToml } from "@castloop/shared";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
const wait = { attempts: 2, delay: async () => {} };
const target = { hostname: "podcasts.example.com", zoneId: "c".repeat(32) };
async function fixture() {
  const f = await sqliteServiceFixture(); values.push(f);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "initial", f.options, wait);
  return f;
}

test("public REST and journals drive add, normal code-only deploy, status and remove without resource adoption", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  const result = await startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait);
  expect(result.phase).toBe("completed"); expect(f.domains).toHaveLength(1);
  const custom = await loadWorkspaceConfig(f.root); expect(custom.public_base_url).toBe(`https://${target.hostname}`);
  expect(await listSqliteDomains(f.root, custom, f.options)).toMatchObject({ connections_match: true, configuration_matches: true });
  expect((await sqliteDomainOperationStatus(f.root, custom, id, f.options)).remote.phase).toBe("completed");
  const attached = f.domains[0];
  await updateSqliteService(f.root, custom, crypto.randomUUID(), "updated", f.options, wait);
  expect(f.domains).toEqual([attached]);
  const removeId = crypto.randomUUID();
  expect((await startSqliteDomainChange(f.root, custom, "remove", removeId, "updated", f.options, undefined, wait)).phase).toBe("completed");
  expect(f.domains).toEqual([]); expect(await loadWorkspaceConfig(f.root)).toEqual(f.config);
  expect(f.runtime.health()).toMatchObject({ state: "paused", publication_ready: true });
  expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});

test("TLS waiting continues the exact acknowledged connection without reconnecting", async () => {
  const f = await fixture(), id = crypto.randomUUID(); f.faults.tlsPending = true;
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow("DNS/TLS");
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("connected");
  expect(await listSqliteDomains(f.root, f.config, f.options)).toMatchObject({ local_pending: [{ operation_id: id, phase: "connected", lock_present: false }] });
  expect((await diagnoseLocal(f.root, {})).checks).toContainEqual(expect.objectContaining({ id: "domain-records", status: "warn" }));
  const calls = f.calls.length;
  await expect(startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait)).rejects.toThrow("unfinished");
  expect(f.calls).toHaveLength(calls);
  f.faults.tlsPending = false;
  expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).phase).toBe("completed");
  expect((await listSqliteDomains(f.root, await loadWorkspaceConfig(f.root), f.options)).local_pending).toEqual([]);
  expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
});

for (const failure of ["attach", "detach"] as const) test(`unknown ${failure} outcome is never adopted or replayed even when current API state shows the result`, async () => {
  const f = await fixture();
  if (failure === "detach") await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root), id = crypto.randomUUID(); f.faults.lostDomain = failure;
  await expect(startSqliteDomainChange(f.root, config, failure === "attach" ? "add" : "remove", id, "worker", f.options, failure === "attach" ? target : undefined, wait)).rejects.toThrow("unknown");
  const phase = failure === "attach" ? "connection_requested" : "detach_requested";
  expect(readSqliteDomainJournal(f.root, config, id)?.phase).toBe(phase);
  expect(f.domains).toHaveLength(failure === "attach" ? 1 : 0);
  const mutations = f.calls.filter((call) => call.method !== "GET" && call.method !== "HEAD").length;
  await expect(continueSqliteDomainChange(f.root, await loadWorkspaceConfig(f.root), id, "worker", f.options, wait)).rejects.toThrow("unknown");
  expect(f.calls.filter((call) => call.method !== "GET" && call.method !== "HEAD")).toHaveLength(mutations);
});

test("malformed DELETE success bodies remain uncertain rather than throwing on null or resending", async () => {
  const f = await fixture(); await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root), id = crypto.randomUUID(); f.faults.malformedDetach = true;
  await expect(startSqliteDomainChange(f.root, config, "remove", id, "worker", f.options, undefined, wait)).rejects.toThrow("not verified");
  expect(readSqliteDomainJournal(f.root, config, id)?.phase).toBe("detach_requested");
  expect(f.domains).toHaveLength(0);
});

test("preflight rejects DNS, delegation, covering routes and foreign or inactive zones before any mutation", async () => {
  for (const kind of ["dns", "delegation", "route", "account", "inactive"] as const) {
    const f = await fixture();
    if (kind === "dns") f.zoneDns.push({ type: "CNAME", name: target.hostname });
    if (kind === "delegation") f.zoneDns.push({ type: "NS", name: "branch.example.com" });
    if (kind === "route") f.routes.push({ pattern: "*.example.com/path/*" });
    if (kind === "account") f.faults.zoneAccount = "f".repeat(32);
    if (kind === "inactive") f.faults.zoneStatus = "pending";
    const api = new SqliteDomainCloudflare(f.config, f.options); f.calls.length = 0;
    await expect(api.preflightAdd(kind === "delegation" ? "podcasts.branch.example.com" : target.hostname, target.zoneId)).rejects.toThrow();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  }
});

test("all DNS pages are inspected and invalid continuation source or local edits are rejected before IO", async () => {
  const f = await fixture();
  f.zoneDns.push(...Array.from({ length: 100 }, (_, index) => ({ type: "TXT", name: `other-${index}.example.com` })), { type: "A", name: target.hostname });
  await expect(new SqliteDomainCloudflare(f.config, f.options).preflightAdd(target.hostname, target.zoneId)).rejects.toThrow("DNS");
  f.zoneDns.length = 0; const id = crypto.randomUUID(); f.faults.tlsPending = true;
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
  f.calls.length = 0;
  await expect(continueSqliteDomainChange(f.root, f.config, id, "different worker", f.options, wait)).rejects.toThrow("frozen");
  expect(f.calls).toEqual([]);
  writeFileSync(join(f.root, "castloop.toml"), 'schema_version = 1\n');
  await expect(continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("connection list reports unexpected extra connections and remove refuses to adopt them", async () => {
  const f = await fixture(); await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root);
  f.domains.push({ ...f.domains[0], id: "0".repeat(32), hostname: "other.example.com" });
  expect((await listSqliteDomains(f.root, config, f.options))).toMatchObject({ connections_match: false, domains: [{}, {}] });
  const mutations = f.calls.filter((call) => call.method === "DELETE").length;
  await expect(startSqliteDomainChange(f.root, config, "remove", crypto.randomUUID(), "worker", f.options, undefined, wait)).rejects.toThrow("membership");
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(mutations);
  expect((await new SqliteServiceClient(config, administratorKey(f.root), f.transport).health()).publication_ready).toBe(true);
});

test("connection listing compares the full known receipt, not only its domain ID", async () => {
  const f = await fixture(); await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root);
  f.domains[0] = { ...f.domains[0], cert_id: crypto.randomUUID() };
  expect(await listSqliteDomains(f.root, config, f.options)).toMatchObject({ connections_match: false });
});

test("ordinary Show updates remain usable after domain changes while completed old drafts are archived without rebinding", async () => {
  const f = await fixture();
  const run = (command: string, args: string[], config = f.config) => runSqliteCommand(f.root, config, command, args, { transport: f.transport, cloudflare: f.options });
  await run("create-show", ["daily", "https://example.com"]); await run("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
  await run("update-show", ["daily"]); await run("publish-show", ["daily"]); await run("show-pause", ["daily", crypto.randomUUID()]);
  const before = await readSqliteDraftRecord(f.root, f.config, { kind: "show", show_id: "daily" });
  const id = crypto.randomUUID();
  await startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root);
  await expect(readSqliteDraftRecord(f.root, config, { kind: "show", show_id: "daily" })).rejects.toThrow("identity");
  await run("show-resume", ["daily", crypto.randomUUID()], config);
  expect(await run("update-show", ["daily"], config)).toMatchObject({ state: "staged" });
  expect(await run("publish-show", ["daily"], config)).toMatchObject({ state: "succeeded" });
  const current = await readSqliteDraftRecord(f.root, config, { kind: "show", show_id: "daily" });
  expect(current?.target.job_id).not.toBe(before?.target.job_id);
  expect(current?.service_config_sha256).not.toBe(before?.service_config_sha256);
  expect(await run("job-status", [before!.target.job_id], config)).toMatchObject({ status: { state: "succeeded" } });
});

test("an acknowledged deployment continues failed REST verification without uploading again", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  f.faults.afterDeploy = () => { f.faults.failFirstInspection = true; };
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("deployed");
  f.faults.afterDeploy = undefined;
  const uploads = f.calls.filter((call) => call.method === "PUT").length;
  expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).phase).toBe("completed");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(uploads);
});

test("lost activation and finalization acknowledgements are reconciled from exact durable completion without POST replay", async () => {
  for (const lost of ["domain-prepare", "domain-activate", "domain-finalize"] as const) {
    const f = await fixture(), id = crypto.randomUUID(); f.faults.lost = lost;
    await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
    f.faults.lost = undefined;
    const posts = f.calls.filter((call) => call.method === "POST" && call.path.endsWith(`/${lost}`)).length;
    expect((await continueSqliteDomainChange(f.root, await loadWorkspaceConfig(f.root), id, "worker", f.options, wait)).phase).toBe("completed");
    expect(f.calls.filter((call) => call.method === "POST" && call.path.endsWith(`/${lost}`))).toHaveLength(posts);
  }
});

test("unknown config PUT acknowledgements remain blocked instead of being inferred from R2 contents", async () => {
  const f = await fixture(), id = crypto.randomUUID(); f.faults.lost = "config";
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("config_requested");
  const calls = f.calls.length;
  await expect(continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).rejects.toThrow("unknown");
  expect(f.calls).toHaveLength(calls);
});

test("partial local configuration sync preserves unrelated edits and resumes only after restoring the exact original", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  f.faults.afterDeploy = () => writeFileSync(join(f.root, "castloop.toml"), stringifyToml({ ...f.config, bucket_name: "unrelated-bucket" }));
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow("Local configuration changed");
  expect((await loadWorkspaceConfig(f.root)).bucket_name).toBe("unrelated-bucket");
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("remote_ready");
  const uploads = f.calls.filter((call) => call.method === "PUT").length;
  writeFileSync(join(f.root, "castloop.toml"), stringifyToml(f.config));
  expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).phase).toBe("completed");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(uploads);
});

test("continuation never finalizes an acknowledged local synchronization after the local configuration was reverted", async () => {
  const f = await fixture(), id = crypto.randomUUID(); f.faults.lost = "domain-finalize";
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("finalize_requested");
  const targetConfig = await loadWorkspaceConfig(f.root);
  writeFileSync(join(f.root, "castloop.toml"), stringifyToml(f.config)); f.calls.length = 0;
  await expect(continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).rejects.toThrow("acknowledged domain synchronization");
  expect(f.calls).toEqual([]);
  writeFileSync(join(f.root, "castloop.toml"), stringifyToml(targetConfig));
  expect((await continueSqliteDomainChange(f.root, targetConfig, id, "worker", f.options, wait)).phase).toBe("completed");
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("unpublished local drafts prevent a domain change before network or journal mutations", async () => {
  const f = await fixture();
  const run = (command: string, args: string[]) => runSqliteCommand(f.root, f.config, command, args, { transport: f.transport, cloudflare: f.options });
  await run("create-show", ["daily", "https://example.com"]); await run("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255)); await run("update-show", ["daily"]);
  await run("show-pause", ["daily", crypto.randomUUID()]); f.calls.length = 0;
  await expect(startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait)).rejects.toThrow("Finish existing local drafts");
  expect(f.calls).toEqual([]);
});

test("domain switching preserves saved Episode identities, unpublished media and immutable history through restore", async () => {
  const f = await fixture();
  let config = f.config;
  const run = (name: string, args: string[]) => runSqliteCommand(f.root, config, name, args, { transport: f.transport, cloudflare: f.options });
  await run("create-show", ["daily", "https://example.com"]); await run("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
  await run("update-show", ["daily"]); await run("publish-show", ["daily"]);
  await run("create-episode", ["daily", "first"]);
  writeFileSync(join(f.root, "daily", "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await run("update-episode", ["daily", "first"]); await run("update-episode-audio", ["daily", "first", "audio.mp3"]); await run("publish-episode", ["daily", "first"]);
  const node = f.nodes.get("daily")!, base = node.service.content.inspect("daily", "first").base!;
  const preserved = new Map([...f.entries].filter(([key]) => !key.includes("/feeds/") && key !== "system/service.toml").map(([key, object]) => [key, object.etag]));
  const local = join(f.root, "daily", "episode-first.toml");
  writeFileSync(local, readFileSync(local, "utf8").replace('title = "first"', 'title = "Unpublished local edit"'));
  const lifecycle = async (action: string) => {
    const plan = sqliteLifecyclePlanSchema.parse(await run("preview-episode-lifecycle", ["daily", "first", action]));
    const file = join(f.root, "reviewed-domain-lifecycle.json"); writeFileSync(file, JSON.stringify(plan));
    await run("lifecycle-execute", [file, plan.request_sha256, "confirm"]);
    expect(await run("job-status", [plan.request.job_id])).toMatchObject({ status: { state: "succeeded" } });
  };
  await lifecycle("unpublish"); await run("show-pause", ["daily", crypto.randomUUID()]);
  await startSqliteDomainChange(f.root, config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  config = await loadWorkspaceConfig(f.root);
  await run("show-resume", ["daily", crypto.randomUUID()]);
  expect(node.service.content.delivery(new URL(base.enclosure_url).pathname).status).toBe(404);
  await lifecycle("restore");
  expect(node.service.content.inspect("daily", "first").base).toEqual(base);
  expect(node.service.content.delivery(new URL(base.enclosure_url).pathname).status).toBe(200);
  const feed = node.service.content.delivery("/podcasts/daily/feed.xml");
  expect(feed.status).toBe(200);
  const feedObject = f.entries.get(sqliteFeedSnapshotKey("daily", node.service.content.inspect("daily").show!.feed_generation))!;
  expect(new TextDecoder().decode(feedObject.bytes)).toContain(`https://${target.hostname}/podcasts/daily/`);
  for (const [key, etag] of preserved) expect(f.entries.get(key)?.etag).toBe(etag);
  expect(readFileSync(local, "utf8")).toContain("Unpublished local edit");
  await run("create-show", ["new-show", "https://example.com/new"]);
  expect(f.nodes.get("new-show")!.service.health()).toMatchObject({ publication_ready: true, state: "paused" });
});
