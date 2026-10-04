import { expect, test } from "bun:test";
import { parseServiceConfig, stringifyToml } from "@castloop/shared";
import type { DomainAdminRequest } from "@castloop/shared";
import { fetchM6ManagementIntegration } from "../../../src/m6-routes";
import { readServiceAdmission, resumeServiceAdmission, SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { domainAdminFixture } from "../../../src/test-support/domain-admin";
import { DomainClient } from "./domain-client";
import { createDomainJournal, readLocalDomainChanges } from "./domain-journal";
import { runDomainCommand } from "./domain-operation";
import type { DomainEffects } from "./domain-operation";
import type { WorkerDomain } from "./cloudflare-api";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = await domainAdminFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-domain-");
  writeFileSync(join(root, "castloop.toml"), stringifyToml(setup.config));
  const requests: Request[] = [];
  const faults: { tls: boolean; purge: boolean; mutation: boolean; lose?: DomainAdminRequest["action"]; delay?: () => Promise<void>;
    claimReply?: boolean; returnConflict?: boolean } = {
    tls: false, purge: false, mutation: false,
  };
  const originalPut = setup.bucket.put;
  setup.bucket.put = async (key, value, options) => {
    if (faults.returnConflict && key === SERVICE_ADMISSION_KEY && typeof value === "string" &&
      JSON.parse(value).url_change && !JSON.parse(value).url_change.execution_id &&
      (await readServiceAdmission(setup.env, "service"))?.value.url_change?.execution_kind === "connection") {
      faults.returnConflict = false;
      return null;
    }
    return originalPut(key, value, options);
  };
  const describe = setup.cachedAssets.describeRuntime;
  const cached = Object.assign(setup.cachedAssets, { describeRuntime: async () => {
    if (faults.claimReply && (await readServiceAdmission(setup.env, "service"))?.value.url_change?.execution_kind === "connection") {
      faults.claimReply = false;
      throw new Error("RPC unavailable after the durable connection claim");
    }
    return describe();
  }, invalidate: async (target: { showId: string }) => {
    if (faults.purge) throw new Error("private purge diagnostics must not enter retained records");
    setup.purges.push(target);
  } });
  const client = new DomainClient(setup.config, "private-secret", async (url, init) => {
    const request = new Request(url, init);
    requests.push(request.clone());
    if (url.origin !== setup.management && faults.tls) throw new Error("DNS/TLS not ready");
    const response = await fetchM6ManagementIntegration(request, setup.env, cached);
    const action = url.pathname === "/admin/domain" ? (JSON.parse(init.body as string) as DomainAdminRequest).action : undefined;
    if (action && faults.lose === action && response.status === 200) {
      faults.lose = undefined;
      await response.body?.cancel();
      throw new Error("response lost after the acknowledged server effect");
    }
    return response;
  });
  const connected: WorkerDomain[] = [];
  const writes: string[] = [];
  const effects: DomainEffects = { admin: (input) => client.call(input), domains: async () => [...connected],
    verifyOrigin: (origin, version) => client.verifyOrigin(origin, version),
    attach: async (hostname, workerName, claim) => {
      if (connected.length) throw new Error("Existing connection is not adopted");
      await claim();
      if (faults.delay) await faults.delay();
      writes.push("attach");
      const domain = { id: "owned-domain", hostname, service: workerName, zone_id: "owned-zone", zone_name: "example.com" };
      connected.push(domain);
      if (faults.mutation) throw new Error("Cloudflare PUT outcome is unknown");
      return domain;
    }, detach: async (_host, _worker, id) => {
      expect(connected[0]?.id).toBe(id);
      writes.push("detach");
      connected.splice(0);
      if (faults.mutation) throw new Error("Cloudflare DELETE outcome is unknown");
    } };
  const config = () => parseServiceConfig(readFileSync(join(root, "castloop.toml"), "utf8"));
  const command = (action: "add" | "list" | "remove", hostname?: string, id?: string) => runDomainCommand(root, config(), action, hostname, id, effects);
  return { ...setup, root, requests, faults, client, connected, writes, effects, config, command };
}

test("domain CLI runner connects both directions through formal management routes, preserves content and finishes paused", async () => {
  const setup = await fixture();
  const media = [...setup.entries].filter(([key]) => key.endsWith(".mp3") || key.startsWith("public/episodes/")).map(([key, value]) => [key, { ...value }] as const);
  await setup.command("add", "Podcasts.Example.COM");
  expect(setup.config().public_base_url).toBe("https://podcasts.example.com");
  expect(setup.text("public/podcasts/daily/feed.xml")).toContain("https://podcasts.example.com/podcasts/daily/feed.xml");
  const beforeList = [...setup.entries];
  const files = readLocalDomainChanges(setup.root, setup.config());
  const listed = await setup.command("list") as { connections_match: boolean; configuration_matches: boolean; local_operations: unknown[] };
  expect(listed).toMatchObject({ connections_match: true, configuration_matches: true, local_operations: [] });
  expect([...setup.entries]).toEqual(beforeList);
  expect(readLocalDomainChanges(setup.root, setup.config())).toEqual(files);
  await setup.command("remove");
  expect(setup.config().public_base_url).toBe(setup.management);
  expect(setup.text("public/podcasts/daily/feed.xml")).toContain(`${setup.management}/podcasts/daily/feed.xml`);
  expect(setup.writes).toEqual(["attach", "detach"]);
  for (const [key, value] of media) expect(setup.entries.get(key)).toEqual(value);
  expect((await readServiceAdmission(setup.env, "service"))?.value).toMatchObject({ state: "paused", pause_id: setup.pauseId });
  expect((await readServiceAdmission(setup.env, "service"))?.value.url_change).toBeUndefined();
  for (const request of setup.requests) {
    if (new URL(request.url).pathname.startsWith("/admin/")) expect(new URL(request.url).origin).toBe(setup.management);
    else {
      expect(new URL(request.url).pathname).toBe("/.well-known/castloop/runtime");
      expect(request.headers.has("X-Castloop-Key")).toBe(false);
      expect(request.headers.has("Authorization")).toBe(false);
    }
  }
  expect(readLocalDomainChanges(setup.root, setup.config()).every((entry) => entry.state.completed && !entry.lock_present)).toBe(true);
});

test("TLS waiting and an acknowledged purge failure continue the same operation without repeating attachment", async () => {
  const setup = await fixture();
  setup.faults.tls = true;
  await expect(setup.command("add", "podcasts.example.com")).rejects.toThrow("DNS/TLS");
  const id = readLocalDomainChanges(setup.root, setup.config())[0]!.state.request.operation_id;
  expect(setup.config().public_base_url).toBe(setup.management);
  await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId)).rejects.toThrow();
  setup.faults.tls = false;
  setup.faults.purge = true;
  await expect(setup.command("add", "podcasts.example.com")).rejects.toThrow("rejected");
  expect(readLocalDomainChanges(setup.root, setup.config())[0]!.state.pending).toBeUndefined();
  setup.faults.purge = false;
  await setup.command("add", "podcasts.example.com");
  expect(readLocalDomainChanges(setup.root, setup.config())[0]!.state.request.operation_id).toBe(id);
  expect(setup.writes).toEqual(["attach"]);
});

test("lost acknowledged management receipts reconcile owned progress without repeating REST mutations", async () => {
  for (const [direction, action] of [["add", "begin"], ["add", "claim-connection"], ["add", "return-connection"],
    ["add", "step"], ["add", "complete"], ["remove", "claim-connection"]] as const) {
    const setup = await fixture();
    if (direction === "remove") await setup.command("add", "podcasts.example.com");
    setup.faults.lose = action;
    const host = direction === "add" ? "podcasts.example.com" : undefined;
    await expect(setup.command(direction, host)).rejects.toThrow("unknown");
    const retained = readLocalDomainChanges(setup.root, setup.config()).find((entry) => !entry.state.completed)!;
    await setup.command(direction, host, retained.state.request.operation_id);
    expect(setup.writes).toEqual(direction === "add" ? ["attach"] : ["attach", "detach"]);
    expect(readLocalDomainChanges(setup.root, setup.config()).every((entry) => entry.state.completed)).toBe(true);
  }
});

test("a live external connection keeps both client lock and admission token until the awaited REST call returns", async () => {
  const setup = await fixture();
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const released = new Promise<void>((resolve) => { finish = resolve; });
  setup.faults.delay = async () => { started(); await released; };
  const running = setup.command("add", "podcasts.example.com");
  await entered;
  try {
    const retained = readLocalDomainChanges(setup.root, setup.config())[0]!;
    expect(retained.lock_present).toBe(true);
    expect(retained.state.pending?.action).toBe("connection");
    await setup.command("list");
    await expect(setup.command("remove")).rejects.toThrow("lock");
    await expect(setup.client.call({ action: "step", request: retained.state.request })).rejects.toThrow("rejected");
    expect(setup.writes).toEqual([]);
    expect(setup.config().public_base_url).toBe(setup.management);
  } finally { finish(); await running; }
  expect(setup.writes).toEqual(["attach"]);
});

test("unknown Cloudflare PUT/DELETE outcomes remain blocked even when read-only lookup sees the expected result", async () => {
  for (const action of ["add", "remove"] as const) {
    const setup = await fixture();
    if (action === "remove") await setup.command("add", "podcasts.example.com");
    setup.faults.mutation = true;
    await expect(setup.command(action, action === "add" ? "podcasts.example.com" : undefined)).rejects.toThrow("unknown");
    const before = [...setup.entries];
    const writes = [...setup.writes];
    await setup.command("list");
    await expect(setup.command(action, action === "add" ? "podcasts.example.com" : undefined)).rejects.toThrow("unknown");
    expect([...setup.entries]).toEqual(before);
    expect(setup.writes).toEqual(writes);
    expect((await readServiceAdmission(setup.env, "service"))?.value.url_change?.execution_kind).toBe("connection");
    await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId)).rejects.toThrow();
  }
});

test("a returned claim error or receipt-return CAS conflict retains the exact token for checked continuation", async () => {
  for (const fault of ["claimReply", "returnConflict"] as const) {
    const setup = await fixture();
    setup.faults[fault] = true;
    await expect(setup.command("add", "podcasts.example.com")).rejects.toThrow("rejected");
    const retained = readLocalDomainChanges(setup.root, setup.config())[0]!.state;
    expect(retained.pending?.action).toBe(fault === "claimReply" ? "claim-connection" : "return-connection");
    expect((await readServiceAdmission(setup.env, "service"))?.value.url_change?.execution_id).toBe(retained.pending?.execution_id);
    await setup.command("add", "podcasts.example.com");
    expect(setup.writes).toEqual(["attach"]);
    expect(readLocalDomainChanges(setup.root, setup.config())[0]!.state.completed).toBe(true);
  }
});

test("local config edits and retained locks are preserved, and unrelated connection records are reported without adoption", async () => {
  const setup = await fixture();
  const originalConfig = setup.config();
  const originalVerify = setup.effects.verifyOrigin;
  let edited = false;
  setup.effects.verifyOrigin = async (origin, version) => {
    await originalVerify(origin, version);
    if (!edited && origin !== setup.management) {
      edited = true;
      writeFileSync(join(setup.root, "castloop.toml"), stringifyToml({ ...setup.config(), bucket_name: "user-edited-bucket" }));
    }
  };
  await expect(setup.command("add", "podcasts.example.com")).rejects.toThrow("unrelated edits");
  expect(setup.config().bucket_name).toBe("user-edited-bucket");
  expect((await readServiceAdmission(setup.env, "service"))?.value.url_change).toBeDefined();
  writeFileSync(join(setup.root, "castloop.toml"), stringifyToml(originalConfig));
  await setup.command("add", "podcasts.example.com");
  const retained = readLocalDomainChanges(setup.root, setup.config())[0]!;
  const path = join(setup.root, ".castloop/domain-changes/service", `${retained.state.request.operation_id}.json.lock`);
  writeFileSync(path, "", { flag: "wx" });
  const before = readFileSync(path);
  await expect(setup.command("add", "podcasts.example.com", retained.state.request.operation_id)).rejects.toThrow("lock");
  expect(readFileSync(path)).toEqual(before);
  setup.connected.push({ id: "foreign", hostname: "other.example.com", service: "another-worker", zone_id: "zone", zone_name: "example.com" });
  const listing = await setup.command("list") as { connections_match: boolean; domains: unknown[] };
  expect(listing.connections_match).toBe(false);
  expect(listing.domains.length).toBe(2);
});

test("local journal freezes identity and receipts, and forged/cached/redirected TLS probes never authorize completion", async () => {
  const setup = await fixture();
  const journal = createDomainJournal(setup.root, setup.config(), setup.request);
  expect(() => journal.save(journal.load())).toThrow("lock");
  await journal.exclusively(async () => {
    expect(() => journal.save({ ...journal.load(), request: { ...setup.request, public_base_url: "https://foreign.example" } })).toThrow();
  });
  for (const mode of ["cached", "foreign", "redirect", "oversized"] as const) {
    const client = new DomainClient(setup.config(), "private-secret", async (url, init) => {
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).has("X-Castloop-Key")).toBe(false);
      if (mode === "redirect") return new Response(null, { status: 301, headers: { Location: setup.management } });
      return Response.json(mode === "oversized" ? "x".repeat(4097) : { schema_version: 1, service_id: "service", worker_name: setup.config().worker_name,
        worker_version_id: mode === "foreign" ? crypto.randomUUID() : setup.versionId,
        nonce: mode === "cached" ? crypto.randomUUID() : url.searchParams.get("nonce") }, { headers: { "Cache-Control": "no-store" } });
    });
    await expect(client.verifyOrigin("https://podcasts.example.com", setup.versionId)).rejects.toThrow();
  }
});
