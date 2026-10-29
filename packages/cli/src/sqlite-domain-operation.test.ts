import { afterEach, expect, spyOn, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { initializeSqliteService } from "./sqlite-initialization";
import { continueSqliteDomainChange, listSqliteDomains, sqliteDomainOperationStatus, startSqliteDomainChange } from "./sqlite-domain-operation";
import { readSqliteDomainJournal, sqliteDomainJournalSchema } from "./sqlite-domain-journal";
import * as journalStorage from "./local-journal-storage";
import { loadWorkspaceConfig } from "./workspace-config";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";
import { SqliteServiceClient } from "./sqlite-service-client";
import { administratorKey } from "./administrator-key";
import { deploySqliteService } from "./sqlite-service-deploy";
import { runSqliteCommand } from "./sqlite-commands";
import { sqliteLifecyclePlanSchema } from "./sqlite-lifecycle";
import { sqliteFeedSnapshotKey } from "../../../src/sqlite-feed";
import { diagnoseLocal } from "./doctor";
import { AgentError, agentEnvelope } from "./agent-output";
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
  await deploySqliteService(f.root, custom, "updated", f.options, wait);
  expect(f.domains).toEqual([attached]);
  const removeId = crypto.randomUUID();
  expect((await startSqliteDomainChange(f.root, custom, "remove", removeId, "updated", f.options, undefined, wait)).phase).toBe("completed");
  expect(f.domains).toEqual([]); expect(await loadWorkspaceConfig(f.root)).toEqual(f.config);
  expect(f.runtime.health()).toMatchObject({ publication_ready: true });
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

test("empty-environment PUT acknowledgement is saved before production GET and is never treated as a full connection", async () => {
  const f = await fixture(), id = crypto.randomUUID(); let sawAcknowledgement = false;
  const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "GET" && /\/workers\/domains\/.+$/.test(path)) {
      const saved = readSqliteDomainJournal(f.root, f.config, id);
      if (!sawAcknowledgement) {
        expect(saved).toMatchObject({ phase: "attachment_acknowledged", attachment_acknowledgement: { environment: "" } });
        expect(saved?.connection).toBeUndefined();
        expect(path.endsWith(`/${saved?.attachment_acknowledgement?.id}`)).toBe(true);
        expect(await loadWorkspaceConfig(f.root)).toEqual(f.config);
        sawAcknowledgement = true;
      }
    }
    const response = await f.transport(input, init);
    if (init?.method === "PUT" && path.endsWith("/workers/domains")) {
      const body = await response.json() as { result: object };
      return Response.json({ success: true, errors: null, result: { ...body.result, environment: "" } });
    }
    return response;
  } };
  const result = await startSqliteDomainChange(f.root, f.config, "add", id, "worker", options, target, wait);
  expect(sawAcknowledgement).toBe(true);
  expect(result).toMatchObject({ phase: "completed", attachment_acknowledgement: { environment: "" }, connection: { environment: "production" } });
  expect(sqliteDomainJournalSchema.safeParse({ ...result, attachment_acknowledgement: undefined }).success).toBe(false);
  expect(sqliteDomainJournalSchema.safeParse({ ...result, attachment_acknowledgement: { ...result.attachment_acknowledgement, cert_id: crypto.randomUUID() } }).success).toBe(false);
});

for (const fault of ["transport", "environment", "cert_id", "id", "enabled", "previews_enabled", "service", "hostname", "zone_id", "zone_name"] as const) {
  test(`acknowledged attachment rejects GET ${fault} and continues only the exact saved receipt without another PUT`, async () => {
    const f = await fixture(), id = crypto.randomUUID(); let failing = true;
    const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
      const path = new URL(String(input)).pathname;
      if (failing && init?.method === "GET" && /\/workers\/domains\/.+$/.test(path)) {
        if (fault === "transport") throw new Error("simulated GET failure");
        const response = await f.transport(input, init), body = await response.json() as { result: object };
        const changes = { environment: "", cert_id: crypto.randomUUID(), id: "other-id", enabled: false,
          previews_enabled: true, service: "other-worker", hostname: "other.example.com", zone_id: "f".repeat(32), zone_name: "other.com" };
        return Response.json({ success: true, errors: null, result: { ...body.result, [fault]: changes[fault] } });
      }
      return f.transport(input, init);
    } };
    await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", options, target, wait)).rejects.toThrow();
    const saved = readSqliteDomainJournal(f.root, f.config, id);
    expect(saved?.phase).toBe("attachment_acknowledged"); expect(saved?.connection).toBeUndefined();
    expect(await loadWorkspaceConfig(f.root)).toEqual(f.config);
    const calls = f.calls.length;
    await expect(continueSqliteDomainChange(f.root, f.config, id, "changed-source", options, wait)).rejects.toThrow("frozen");
    expect(f.calls).toHaveLength(calls);
    failing = false;
    expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", options, wait)).phase).toBe("completed");
    expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
  });
}

test("failure to durably save an attachment acknowledgement completes via current API state on continuation without a second PUT", async () => {
  const f = await fixture(), id = crypto.randomUUID(), original = journalStorage.createLocalJournalStorage;
  let failSave = true;
  const replacement = spyOn(journalStorage, "createLocalJournalStorage").mockImplementation((...args) => {
    const storage = original(...args);
    return { ...storage, replace(value) {
      if (failSave && (value as { phase?: string }).phase === "attachment_acknowledged") throw new Error("simulated receipt storage failure");
      storage.replace(value);
    } };
  });
  try {
    await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow("storage failure");
    expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("maintenance");
    expect(f.calls.filter((call) => /\/workers\/domains\/.+$/.test(call.path))).toEqual([]);
    failSave = false;
    expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).phase).toBe("completed");
    expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
  } finally { replacement.mockRestore(); }
});

for (const failure of ["attach", "detach"] as const) test(`interrupted ${failure} response completes idempotently on continuation via current API state`, async () => {
  const f = await fixture();
  if (failure === "detach") await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root), id = crypto.randomUUID(); f.faults.lostDomain = failure;
  await expect(startSqliteDomainChange(f.root, config, failure === "attach" ? "add" : "remove", id, "worker", f.options, failure === "attach" ? target : undefined, wait)).rejects.toThrow("unknown");
  const phase = failure === "attach" ? "maintenance" : "local_synced";
  expect(readSqliteDomainJournal(f.root, config, id)?.phase).toBe(phase);
  expect(f.domains).toHaveLength(failure === "attach" ? 1 : 0);
  f.faults.lostDomain = undefined;
  expect((await continueSqliteDomainChange(f.root, await loadWorkspaceConfig(f.root), id, "worker", f.options, wait)).phase).toBe("completed");
  expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
  if (failure === "detach") expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});

test("malformed DELETE success bodies fail verification cleanly", async () => {
  const f = await fixture(); await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root), id = crypto.randomUUID(); f.faults.malformedDetach = true;
  await expect(startSqliteDomainChange(f.root, config, "remove", id, "worker", f.options, undefined, wait)).rejects.toThrow("not verified");
  expect(readSqliteDomainJournal(f.root, config, id)?.phase).toBe("local_synced");
  expect(f.domains).toHaveLength(0);
});

for (const body of ["stream", "null"] as const) test(`DELETE HTTP 200 with Content-Length zero and an empty ${body} body durably completes detachment`, async () => {
  const f = await fixture();
  await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root), id = crypto.randomUUID();
  const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
    const response = await f.transport(input, init);
    return init?.method === "DELETE" ? new Response(body === "stream" ? "" : null, { headers: { "Content-Length": "0" } }) : response;
  } };
  const result = await startSqliteDomainChange(f.root, config, "remove", id, "worker", options, undefined, wait);
  expect(result).toMatchObject({ phase: "completed", detach_acknowledged: true });
  expect(await loadWorkspaceConfig(f.root)).toEqual(f.config); expect(f.domains).toEqual([]);
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  expect((await new SqliteServiceClient(f.config, administratorKey(f.root), f.transport).health()).publication_ready).toBe(true);
});

for (const kind of ["missing_length", "whitespace", "nonempty", "status", "partial", "truncated", "json_error"] as const) {
  test(`DELETE ${kind} is not accepted as an empty acknowledgement`, async () => {
    const f = await fixture();
    await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
    const config = await loadWorkspaceConfig(f.root), id = crypto.randomUUID();
    const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
      const response = await f.transport(input, init);
      if (init?.method !== "DELETE") return response;
      if (kind === "missing_length") return new Response("");
      if (kind === "status") return new Response(null, { status: 204, headers: { "Content-Length": "0" } });
      if (kind === "partial") return new Response("", { headers: { "Content-Length": "0", "Content-Range": "bytes */0" } });
      if (kind === "truncated") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("unsettled response")); } }), { headers: { "Content-Length": "0" } });
      if (kind === "json_error") return Response.json({ success: false, errors: [{ code: 1000 }] });
      return new Response(kind === "whitespace" ? " \n" : "unexpected", { headers: { "Content-Length": "0" } });
    } };
    await expect(startSqliteDomainChange(f.root, config, "remove", id, "worker", options, undefined, wait)).rejects.toThrow();
    const state = readSqliteDomainJournal(f.root, config, id);
    expect(state?.phase).toBe("local_synced"); expect(state?.detach_acknowledged).toBeUndefined();
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
}

test("an unverified attachment receipt leaves the journal in maintenance without saving a connection", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
    const response = await f.transport(input, init);
    if (init?.method === "PUT" && new URL(String(input)).pathname.endsWith("/workers/domains")) {
      const body = await response.json() as { result: object };
      return Response.json({ success: true, errors: null, result: { ...body.result, id: "invalid/domain" } });
    }
    return response;
  } };
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", options, target, wait)).rejects.toThrow();
  const journal = readSqliteDomainJournal(f.root, f.config, id);
  expect(journal?.phase).toBe("maintenance"); expect(journal?.connection).toBeUndefined();
  expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
});

test("attachment validation diagnostics expose only allowlisted field names and codes, never response values or unknown keys", async () => {
  const f = await fixture(), id = crypto.randomUUID(), secret = "private-provider-response-value";
  const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
    const response = await f.transport(input, init);
    if (init?.method === "PUT" && new URL(String(input)).pathname.endsWith("/workers/domains")) {
      const body = await response.json() as { result: object };
      return Response.json({ success: true, errors: null, result: { ...body.result, cert_id: secret, [secret]: secret } });
    }
    return response;
  } };
  let failure: unknown;
  try { await startSqliteDomainChange(f.root, f.config, "add", id, "worker", options, target, wait); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AgentError);
  const output = agentEnvelope("domain", { workspace: f.root }, { operation_id: id, phase: "maintenance" }, failure, true);
  expect(output.error).toMatchObject({ code: "domain_connection_unverified", outcome: "unknown",
    fields: [{ path: ["cert_id"], code: "invalid_format" }, { path: [], code: "unrecognized_keys" }] });
  expect(JSON.stringify(output)).not.toContain(secret);
  expect(output.next_actions).not.toContainEqual(expect.objectContaining({ args: ["continue", id] }));
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("maintenance");
  expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
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

test("ordinary direct publication remains usable after domain changes without draft rebinding", async () => {
  const f = await fixture();
  const run = (command: string, args: string[], config = f.config) => runSqliteCommand(f.root, config, command, args, { transport: f.transport, cloudflare: f.options });
  await run("create-show", ["daily", "https://example.com"]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
  await run("publish-show", ["daily"]);
  const id = crypto.randomUUID();
  await startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait);
  const config = await loadWorkspaceConfig(f.root);
  expect(await run("publish-show", ["daily"], config)).toMatchObject({ result: "unchanged" });
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

test("native rollout waiting is diagnosed explicitly and continues the saved deployment without another upload", async () => {
  const f = await fixture(), id = crypto.randomUUID(), previous = f.runtime.health(); let pending = true;
  const options = { ...f.options, transport: async (input: Parameters<typeof f.transport>[0], init?: Parameters<typeof f.transport>[1]) => {
    const response = await f.transport(input, init);
    if (pending && new URL(String(input)).pathname.endsWith("/registration-health")) {
      const body = await response.json() as object;
      return Response.json({ ...body, worker_version_id: previous.worker_version_id, service_config_sha256: previous.service_config_sha256 }, { headers: response.headers });
    }
    return response;
  } };
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", options, target, wait)).rejects.toMatchObject({ code: "domain_rollout_pending" });
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("verified");
  const uploads = f.calls.filter((call) => call.method === "PUT").length; pending = false;
  expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", options, wait)).phase).toBe("completed");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(uploads);
});

test("interrupted prepare, commit and finalize steps complete idempotently on continuation", async () => {
  for (const lost of ["domain-prepare", "domain-commit", "domain-finalize"] as const) {
    const f = await fixture(), id = crypto.randomUUID(); f.faults.lost = lost;
    await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
    f.faults.lost = undefined;
    expect((await continueSqliteDomainChange(f.root, await loadWorkspaceConfig(f.root), id, "worker", f.options, wait)).phase).toBe("completed");
  }
});

test("interrupted config PUT completes idempotently on continuation", async () => {
  const f = await fixture(), id = crypto.randomUUID(); f.faults.lost = "config";
  await expect(startSqliteDomainChange(f.root, f.config, "add", id, "worker", f.options, target, wait)).rejects.toThrow();
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("connected");
  f.faults.lost = undefined;
  expect((await continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).phase).toBe("completed");
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
  expect(readSqliteDomainJournal(f.root, f.config, id)?.phase).toBe("local_synced");
  f.faults.lost = undefined;
  const targetConfig = await loadWorkspaceConfig(f.root);
  writeFileSync(join(f.root, "castloop.toml"), stringifyToml(f.config)); f.calls.length = 0;
  await expect(continueSqliteDomainChange(f.root, f.config, id, "worker", f.options, wait)).rejects.toThrow("acknowledged domain synchronization");
  expect(f.calls).toEqual([]);
  writeFileSync(join(f.root, "castloop.toml"), stringifyToml(targetConfig));
  expect((await continueSqliteDomainChange(f.root, targetConfig, id, "worker", f.options, wait)).phase).toBe("completed");
});

test("unpublished local inputs do not impose a draft lock on dedicated domain maintenance", async () => {
  const f = await fixture();
  const run = (command: string, args: string[]) => runSqliteCommand(f.root, f.config, command, args, { transport: f.transport, cloudflare: f.options });
  await run("create-show", ["daily", "https://example.com"]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
  f.calls.length = 0;
  expect(await startSqliteDomainChange(f.root, f.config, "add", crypto.randomUUID(), "worker", f.options, target, wait)).toMatchObject({ phase: "completed" });
  expect(readFileSync(join(f.root, "daily", "cover.jpg"))).toEqual(Buffer.from([255, 216, 255]));
});

test("domain switching preserves saved Episode identities, unpublished media and immutable history through restore", async () => {
  const f = await fixture();
  let config = f.config;
  const run = (name: string, args: string[]) => runSqliteCommand(f.root, config, name, args, { transport: f.transport, cloudflare: f.options });
  await run("create-show", ["daily", "https://example.com"]);
  writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
  await run("publish-show", ["daily"]);
  await run("create-episode", ["daily", "first"]);
  writeFileSync(join(f.root, "daily", "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await run("publish-episode", ["daily", "first", "audio.mp3"]);
  const node = f.nodes.get("daily")!, base = node.service.content.inspect("daily", "first").base!;
  const preserved = new Map([...f.entries].filter(([key]) => !key.includes("/feeds/") && key !== "system/service.toml").map(([key, object]) => [key, object.etag]));
  const local = join(f.root, "daily", "episode-first.toml");
  writeFileSync(local, readFileSync(local, "utf8").replace('title = "first"', 'title = "Unpublished local edit"'));
  const lifecycle = async (action: string) => {
    const plan = sqliteLifecyclePlanSchema.parse(await run("preview-episode-lifecycle", ["daily", "first", action]));
    const file = join(f.root, "reviewed-domain-lifecycle.json"); writeFileSync(file, JSON.stringify(plan));
    expect(await run("lifecycle-execute", [file, plan.request_sha256, "confirm"])).toMatchObject({ result: "changed" });
  };
  await lifecycle("unpublish");
  await startSqliteDomainChange(f.root, config, "add", crypto.randomUUID(), "worker", f.options, target, wait);
  config = await loadWorkspaceConfig(f.root);
  expect(node.service.content.delivery(new URL(base.enclosure_url).pathname).status).toBe(404);
  await lifecycle("restore");
  expect(node.service.content.inspect("daily", "first").base).toEqual(base);
  expect(node.service.content.delivery(new URL(base.enclosure_url).pathname).status).toBe(200);
  const feed = node.service.content.delivery("/podcasts/daily/feed.xml");
  expect(feed.status).toBe(200);
  expect(node.service.renderFeed()!.xml).toContain(`https://${target.hostname}/podcasts/daily/`);
  for (const [key, etag] of preserved) expect(f.entries.get(key)?.etag).toBe(etag);
  expect(readFileSync(local, "utf8")).toContain("Unpublished local edit");
  await run("create-show", ["new-show", "https://example.com/new"]);
  expect(f.nodes.get("new-show")!.service.health()).toMatchObject({ publication_ready: true });
});
