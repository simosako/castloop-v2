import { expect, test } from "bun:test";
import { parseSqliteDomainRequest, requireSqliteDomainConnection, SQLITE_DOMAIN_PROTOCOL,
  sqliteDomainHostnameSchema, sqliteDomainIdSchema, sqliteDomainRequestHash, sqliteDomainRequestSchema, sqliteDomainServiceStatusSchema } from "./sqlite-domain";
import { sqliteServiceConfigHash } from "./sqlite-service";

async function fixture(action: "add" | "remove" = "add") {
  const management = "https://castloop-service.example.workers.dev", custom = "https://podcasts.example.com";
  const previous = { schema_version: 2 as const, storage_layout: "show-v1" as const, publication_protocol: "sqlite-sequential-v1" as const,
    service_id: "service", account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "castloop-service",
    public_base_url: action === "add" ? management : custom, workers_dev_base_url: management };
  const target = { ...previous, public_base_url: action === "add" ? custom : management };
  return { schema_version: 1 as const, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: crypto.randomUUID(), action,
    hostname: "podcasts.example.com", zone_id: "b".repeat(32), zone_name: "example.com", namespace_id: "c".repeat(32),
    previous_runtime: { service_id: previous.service_id, worker_version_id: crypto.randomUUID(),
      service_config_sha256: await sqliteServiceConfigHash(previous) }, previous_config: previous, target_config: target,
    target_config_sha256: await sqliteServiceConfigHash(target), worker_source_sha256: "d".repeat(64), worker_metadata_sha256: "e".repeat(64),
    ...(action === "remove" ? { connection: { id: "f".repeat(32), cert_id: crypto.randomUUID(), hostname: "podcasts.example.com",
      zone_id: "b".repeat(32), zone_name: "example.com", service: previous.worker_name, environment: "production" as const,
      enabled: true as const, previews_enabled: false as const } } : {}) };
}

test("domain hostname validation canonicalizes ASCII case and rejects non-hostname inputs", () => {
  expect(sqliteDomainHostnameSchema.parse("Podcasts.Example.COM")).toBe("podcasts.example.com");
  for (const input of ["", " example.com", "https://podcasts.example.com", "example.com/", "example.com:443", "*.example.com",
    "user@example.com", "example.com?x=y", "example.com#x", "example.com.", "a..example.com", "-a.example.com", "a-.example.com",
    `${"a".repeat(64)}.example.com`, "127.0.0.1", "[::1]", "localhost", "a_b.example.com", "音声.example.com",
    "xn--test.example.com", "a.xn--test.com", "worker.account.workers.dev"]) {
    expect(sqliteDomainHostnameSchema.safeParse(input).success).toBe(false);
  }
});

test("Worker domain IDs are bounded opaque path segments, not account or Zone IDs", async () => {
  for (const value of ["d".repeat(32), "d".repeat(40), "opaque-domain_ID-1"]) {
    expect(sqliteDomainIdSchema.parse(value)).toBe(value);
    const request = await fixture("remove");
    expect(await parseSqliteDomainRequest({ ...request, connection: { ...request.connection, id: value } })).toMatchObject({ connection: { id: value } });
  }
  for (const value of ["", "x".repeat(257), ".", "..", "a/b", "a?b", "a#b", "a%b", "a b", "a\nb"]) {
    expect(sqliteDomainIdSchema.safeParse(value).success).toBe(false);
  }
  const request = await fixture("remove");
  expect(sqliteDomainRequestSchema.safeParse({ ...request, zone_id: "d".repeat(40) }).success).toBe(false);
  expect(sqliteDomainRequestSchema.safeParse({ ...request, namespace_id: "d".repeat(40) }).success).toBe(false);
});

test("add and remove bind both complete configurations, management identity and parent zone", async () => {
  for (const action of ["add", "remove"] as const) {
    const request = await fixture(action);
    expect(await parseSqliteDomainRequest(request)).toEqual(request);
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    expect(await sqliteDomainRequestHash(request)).toBe(await sqliteDomainRequestHash(reordered));
    expect(await sqliteDomainRequestHash(request)).not.toBe(await sqliteDomainRequestHash({ ...request, operation_id: crypto.randomUUID() }));
  }
});

test("domain requests reject changed resources, management origins, schemas and unrelated config fields", async () => {
  const request = await fixture();
  for (const change of [{ account_id: "f".repeat(32) }, { service_id: "other" }, { worker_name: "another-worker" },
    { bucket_name: "another-bucket" }, { workers_dev_base_url: "https://castloop-service.other.workers.dev" },
    { storage_layout: "legacy" }, { schema_version: 1 }, { api_token: "secret" }]) {
    expect(sqliteDomainRequestSchema.safeParse({ ...request, target_config: { ...request.target_config, ...change } }).success).toBe(false);
  }
  for (const change of [{ protocol: "sqlite-sequential-v1" }, { schema_version: 2 }, { zone_name: "example.net" },
    { zone_name: "podcasts.example.com" }, { hostname: "notexample.com" }, { hostname: "other.example.com" },
    { owner_token: "unknown" }, { target_config: request.previous_config },
    { previous_runtime: { ...request.previous_runtime, service_id: "other" } }]) {
    expect(sqliteDomainRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  }
});

test("hash validation is required even when the structural request is valid", async () => {
  const request = await fixture();
  for (const change of [{ target_config_sha256: "f".repeat(64) },
    { previous_runtime: { ...request.previous_runtime, service_config_sha256: "f".repeat(64) } }]) {
    const input = { ...request, ...change };
    expect(sqliteDomainRequestSchema.safeParse(input).success).toBe(true);
    await expect(parseSqliteDomainRequest(input)).rejects.toThrow("hashes");
    await expect(sqliteDomainRequestHash(input)).rejects.toThrow("hashes");
  }
});

test("remove requires the exact connected origin and workers.dev restoration, not a domain replacement", async () => {
  const request = await fixture("remove");
  for (const public_base_url of ["https://other.example.com", "https://example.com", request.previous_config.public_base_url]) {
    expect(sqliteDomainRequestSchema.safeParse({ ...request, target_config: { ...request.target_config, public_base_url } }).success).toBe(false);
  }
  expect(sqliteDomainRequestSchema.safeParse({ ...request,
    previous_config: { ...request.previous_config, public_base_url: request.target_config.public_base_url } }).success).toBe(false);
});

test("connection receipts require exact targets and cannot enable previews or adopt another Worker", async () => {
  const request = await fixture();
  const connection = { id: "f".repeat(32), cert_id: crypto.randomUUID(), hostname: request.hostname,
    zone_id: request.zone_id, zone_name: request.zone_name, service: request.previous_config.worker_name,
    environment: "production" as const, enabled: true as const, previews_enabled: false as const };
  expect(requireSqliteDomainConnection(connection, request)).toEqual(connection);
  for (const change of [{ hostname: "other.example.com" }, { zone_id: "0".repeat(32) }, { zone_name: "example.net" },
    { service: "another-worker" }, { environment: "preview" }, { enabled: false }, { previews_enabled: true }, { secret: "not-allowed" }]) {
    expect(() => requireSqliteDomainConnection({ ...connection, ...change }, request)).toThrow();
  }
});

test("remove freezes a known connection ID and certificate receipt instead of adopting the current hostname", async () => {
  const request = await fixture("remove"), connection = request.connection!;
  expect(requireSqliteDomainConnection(connection, request)).toEqual(connection);
  expect(sqliteDomainRequestSchema.safeParse({ ...request, connection: undefined }).success).toBe(false);
  const add = await fixture();
  expect(sqliteDomainRequestSchema.safeParse({ ...add, connection }).success).toBe(false);
  for (const change of [{ id: "0".repeat(32) }, { cert_id: crypto.randomUUID() }]) {
    expect(() => requireSqliteDomainConnection({ ...connection, ...change }, request)).toThrow();
    expect(await sqliteDomainRequestHash({ ...request, connection: { ...connection, ...change } })).not.toBe(await sqliteDomainRequestHash(request));
  }
  expect(sqliteDomainRequestSchema.safeParse({ ...request, connection: { ...connection, hostname: "other.example.com" } }).success).toBe(false);
});

test("service completion requires consistent aggregate counts rather than only the displayed target page", async () => {
  const request = await fixture();
  const status = { own: { request, request_sha256: await sqliteDomainRequestHash(request), actual_runtime: request.previous_runtime,
    saved_runtime: request.previous_runtime, phase: "completed", feed_generation: null, activation: null, paused: true, drained: true, reason_code: null },
    phase: "probing", targets_native_ready: true, all_completed: false, target_count: 21, prepared_count: 21,
    completed_count: 20, released_count: 0, blocked_count: 0, targets: [], next_cursor: null };
  expect(sqliteDomainServiceStatusSchema.safeParse(status).success).toBe(true);
  for (const change of [{ all_completed: true }, { completed_count: 22 }, { blocked_count: 2 }, { released_count: 22 }, { phase: "completed" }]) {
    expect(sqliteDomainServiceStatusSchema.safeParse({ ...status, ...change }).success).toBe(false);
  }
  expect(sqliteDomainServiceStatusSchema.safeParse({ ...status, all_completed: true, completed_count: 21 }).success).toBe(true);
});
