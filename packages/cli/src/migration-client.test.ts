import { expect, test } from "bun:test";
import { parseServiceConfig } from "@castloop/shared";
import { MigrationAdminClient } from "./migration-client";
import { bootstrapFixture } from "../../../src/test-support/bootstrap";
import { handleMigrationAdmin } from "../../../src/migration-admin";
import { createMigrationDeploymentJournal, migrationPayloadHash, runMigrationCandidateDeployment } from "./migration-deployment";
import { mkdtempSync, rmSync } from "node:fs";

test("migration client uses authenticated fixed-origin requests without redirect or retry; validates server status", async () => {
  const setup = await bootstrapFixture();
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const calls: Request[] = [];
  const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const request = new Request(input, init);
    calls.push(request);
    expect(new URL(request.url).origin).toBe(new URL(config.public_base_url).origin);
    expect(request.headers.get("X-Castloop-Key")).toBe("private-key");
    const response = await handleMigrationAdmin(request, setup.env, calls.length > 3 ? setup.candidate : setup.bridge);
    if (!response) throw new Error("Unexpected migration request");
    return response;
  }, { preconnect: () => {} });
  const client = new MigrationAdminClient(config, "private-key", transport);
  expect((await client.status()).admission?.state).toBe("migrating");
  await client.prepareDeployment(setup.bootstrapRequest);
  expect((await client.beginDeployment(setup.bootstrapRequest)).start_allowed).toBe(true);
  await client.settleDeployment(setup.bootstrapRequest, setup.settlement);
  const status = await client.status();
  expect(status.bootstrap?.phase).toBe("verifying");
  expect(status.m6_ready).toBe(false);
  expect(calls.map((request) => request.method)).toEqual(["GET", "POST", "POST", "POST", "GET"]);
});

test("client rejects foreign service/deployment before HTTP and does not leak arbitrary error response text", async () => {
  const setup = await bootstrapFixture();
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  let calls = 0;
  const transport = Object.assign(async () => { calls += 1; return new Response("private-token-and-email", { status: 409 }); }, { preconnect: () => {} });
  const client = new MigrationAdminClient(config, "private-key", transport);
  await expect(client.prepareDeployment({ ...setup.bootstrapRequest, service_id: "another" })).rejects.toThrow("another service");
  await expect(client.settleDeployment(setup.bootstrapRequest, { ...setup.settlement,
    deployment: { ...setup.settlement.deployment, account_id: "b".repeat(32) } })).rejects.toThrow("another service");
  expect(calls).toBe(0);
  let message = "";
  try { await client.beginDeployment(setup.bootstrapRequest); } catch (error) { message = error instanceof Error ? error.message : "unknown"; }
  expect(message).toContain("HTTP 409");
  expect(message).not.toContain("private-token-and-email");
  expect(calls).toBe(1);
});

test("client response stream budget cancels oversized status and invalid schemas never become evidence", async () => {
  const setup = await bootstrapFixture();
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  let cancelled = false;
  const transport = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(33000)); }, cancel() { cancelled = true; },
  })), { preconnect: () => {} });
  await expect(new MigrationAdminClient(config, "private-key", transport).status()).rejects.toThrow("budget");
  expect(cancelled).toBe(true);
  const malformed = Object.assign(async () => Response.json({ m6_ready: true, private: "secret" }), { preconnect: () => {} });
  await expect(new MigrationAdminClient(config, "private-key", malformed).status()).rejects.toThrow();
});

test("migration administrator credentials are not sent to nonorigin, credential-bearing or insecure URLs", async () => {
  const setup = await bootstrapFixture();
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  for (const public_base_url of ["http://example.com", "https://user:password@example.com", "https://example.com/other", "https://example.com/?query=1"]) {
    expect(() => new MigrationAdminClient({ ...config, public_base_url }, "private-key")).toThrow();
  }
  expect(() => new MigrationAdminClient(config, "")).toThrow("local administrator key");
});

test("durable deployment driver and HTTP client integrate with owned server bootstrap without opening writes", async () => {
  const setup = await bootstrapFixture();
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const root = mkdtempSync("/tmp/opencode/castloop-migration-client-");
  const source = "export default {};";
  const metadata = { main_module: "index.js" };
  const request = { ...setup.bootstrapRequest, worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) };
  let deployed = false;
  let puts = 0;
  const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await handleMigrationAdmin(new Request(input, init), setup.env, deployed ? setup.candidate : setup.bridge);
    if (!response) throw new Error("Unexpected route");
    return response;
  }, { preconnect: () => {} });
  const client = new MigrationAdminClient(config, "private-key", transport);
  try {
    const journal = createMigrationDeploymentJournal(root, request);
    await runMigrationCandidateDeployment(journal, {
      prepare: (input) => client.prepareDeployment(input), begin: (input) => client.beginDeployment(input),
      deploy: async () => { puts += 1; deployed = true; return setup.candidateVersion; },
      inspect: async () => setup.settlement.deployment,
      settle: (input, evidence) => client.settleDeployment(input, evidence),
    }, source, metadata);
    expect(puts).toBe(1);
    expect(journal.load().phase).toBe("settled");
    const status = await client.status();
    expect(status.bootstrap?.phase).toBe("verifying");
    expect(status.admission?.mode).toBe("legacy");
    expect(status.admission?.state).toBe("migrating");
    expect(status.m6_ready).toBe(false);
  } finally { rmSync(root, { recursive: true }); }
});
