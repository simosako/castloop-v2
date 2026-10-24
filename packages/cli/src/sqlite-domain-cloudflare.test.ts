import { expect, spyOn, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";
import { parseSqliteDomainRequest, SQLITE_DOMAIN_PROTOCOL } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";

test("an empty native Worker domain list permits null errors and count-complete pagination without total_pages", async () => {
  const f = await sqliteServiceFixture();
  try {
    const api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async (input, init) => {
      const response = await f.transport(input, init);
      if (new URL(String(input)).pathname.endsWith("/workers/domains")) {
        return Response.json({ success: true, errors: null, result: [],
          result_info: { page: 1, per_page: 0, count: 0, total_count: 0 } });
      }
      return response;
    } });
    expect(await api.list()).toEqual([]);
    expect(await api.preflightAdd("podcasts.example.com", "c".repeat(32))).toMatchObject({ hostname: "podcasts.example.com" });
  } finally { f.close(); }
});

test("native null-error envelopes still reject unsuccessful, error-bearing and incomplete domain responses", async () => {
  const f = await sqliteServiceFixture();
  try {
    for (const fields of [
      { success: false }, { errors: [{ code: 1000 }] }, { errors: undefined },
      { result_info: { page: 1, per_page: 0, count: 0, total_count: 1 } },
      { result_info: { page: 2, per_page: 0, count: 0, total_count: 0 } },
      { result_info: { page: 1, per_page: 0, count: 0, total_count: 0, total_pages: 2 } },
    ]) {
      const api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async () => Response.json({
        success: true, errors: null, result: [], result_info: { page: 1, per_page: 0, count: 0, total_count: 0 }, ...fields,
      }) });
      await expect(api.list()).rejects.toThrow();
    }
  } finally { f.close(); }
});

test("a populated native Worker domain list preserves its 40-character ID without truncation", async () => {
  const f = await sqliteServiceFixture();
  try {
    const connection = { id: "a".repeat(40), cert_id: crypto.randomUUID(), hostname: "podcasts.example.com", zone_id: "c".repeat(32),
      zone_name: "example.com", service: f.config.worker_name, environment: "production", enabled: true, previews_enabled: false };
    const api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async () => Response.json({
      success: true, errors: null, result: [connection], result_info: { page: 1, per_page: 1, count: 1, total_count: 1 },
    }) });
    expect(await api.list()).toEqual([connection]);
    await new SqliteDomainCloudflare({ ...f.config, public_base_url: "https://podcasts.example.com" }, {
      ...f.options, transport: async () => Response.json({ success: true, errors: null, result: [connection] }),
    }).verifyKnown({ ...connection, environment: "production", enabled: true, previews_enabled: false });
  } finally { f.close(); }
});

test("DNS pagination retains its explicit page-size and final-page requirements", async () => {
  const f = await sqliteServiceFixture();
  try {
    for (const info of [
      { page: 1, per_page: 0, count: 0, total_count: 0, total_pages: 1 },
      { page: 1, per_page: 100, count: 0, total_count: 0 },
    ]) {
      const api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/dns_records")) return Response.json({ success: true, errors: null, result: [], result_info: info });
        return f.transport(input, init);
      } });
      await expect(api.preflightAdd("podcasts.example.com", "c".repeat(32))).rejects.toThrow();
    }
  } finally { f.close(); }
});

async function attachmentRequest(f: Awaited<ReturnType<typeof sqliteServiceFixture>>) {
  const target = { ...f.config, public_base_url: "https://podcasts.example.com" };
  return parseSqliteDomainRequest({ schema_version: 1, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: crypto.randomUUID(), action: "add",
    hostname: "podcasts.example.com", zone_id: "c".repeat(32), zone_name: "example.com", namespace_id: "b".repeat(32),
    previous_runtime: f.runtime.queue.identity(), previous_config: f.config, target_config: target,
    target_config_sha256: await sqliteServiceConfigHash(target), worker_source_sha256: "d".repeat(64), worker_metadata_sha256: "e".repeat(64) });
}

test("attachment logs distinguish missing, null, unexpected and non-string environment fields without exposing values", async () => {
  const records: string[] = [], logger = spyOn(console, "error").mockImplementation((line) => { records.push(String(line)); });
  try {
    for (const [kind, change] of [
      ["missing", {}], ["null", { environment: null }],
      ["other_string", { environment: "private-provider-environment" }], ["non_string", { environment: { secret: "private-provider-environment" } }],
    ] as const) {
      const f = await sqliteServiceFixture();
      try {
        const request = await attachmentRequest(f), api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async (input, init) => {
          const response = await f.transport(input, init);
          if (init?.method === "PUT") {
            const body = await response.json() as { result: Record<string, unknown> };
            const { environment: _environment, ...connection } = body.result;
            return Response.json({ success: true, errors: null, result: { ...connection, ...change } });
          }
          return response;
        } });
        const count = records.length;
        await expect(api.attach(request)).rejects.toThrow("receipt was not verified");
        expect(records).toHaveLength(count + 1);
        expect(JSON.parse(records.at(-1)!)).toEqual({ event: "sqlite_domain_cloudflare", api_operation: "domain_attach", method: "PUT",
          reason_code: "connection_schema_unverified", http_status: 200, response_kind: "object", environment_kind: kind,
          expected_environment: "empty_or_production", fields: [{ path: ["environment"], code: "invalid_value" }], will_retry: false });
        expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
      } finally { f.close(); }
    }
    expect(records.join("\n")).not.toContain("private-provider-environment");
    expect(records.join("\n")).not.toContain("private-token");
    expect(records.join("\n")).not.toContain("podcasts.example.com");
    expect(records.join("\n")).not.toContain("secret");
  } finally { logger.mockRestore(); }
});

test("GET connection validation logs its own boundary and successful receipts produce no error logs", async () => {
  const f = await sqliteServiceFixture(), records: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => { records.push(String(line)); });
  try {
    const request = await attachmentRequest(f), api = new SqliteDomainCloudflare(f.config, f.options);
    const connection = await api.confirmAttachment(request, await api.attach(request)); await api.inspect(request, connection);
    expect(records).toEqual([]);
    const invalid = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async (input, init) => {
      const response = await f.transport(input, init);
      if (new URL(String(input)).pathname.endsWith(`/domains/${connection.id}`)) {
        const body = await response.json() as { result: object };
        return Response.json({ success: true, errors: [], result: { ...body.result, environment: "" } });
      }
      return response;
    } });
    await expect(invalid.inspect(request, connection)).rejects.toThrow("receipt was not verified");
    expect(JSON.parse(records[0]!)).toMatchObject({ api_operation: "domain_get", method: "GET", reason_code: "connection_schema_unverified", environment_kind: "empty_string" });
    expect(records).toHaveLength(1);
  } finally { logger.mockRestore(); f.close(); }
});

test("connection target and saved-receipt mismatches have distinct diagnostics without identifiers", async () => {
  const f = await sqliteServiceFixture(), records: string[] = [];
  const logger = spyOn(console, "error").mockImplementation((line) => { records.push(String(line)); });
  try {
    const request = await attachmentRequest(f), api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async (input, init) => {
      const response = await f.transport(input, init);
      if (init?.method === "PUT") {
        const body = await response.json() as { result: object };
        return Response.json({ success: true, errors: [], result: { ...body.result, service: "private-other-worker" } });
      }
      return response;
    } });
    await expect(api.attach(request)).rejects.toThrow("receipt was not verified");
    expect(JSON.parse(records[0]!)).toMatchObject({ api_operation: "domain_attach", reason_code: "connection_target_mismatch", environment_kind: "production" });
    const saved = { ...f.domains[0]! }; f.domains[0] = { ...saved, cert_id: crypto.randomUUID() };
    await expect(api.inspect(request, saved)).rejects.toThrow("receipt changed");
    expect(JSON.parse(records[1]!)).toMatchObject({ api_operation: "domain_get", reason_code: "connection_receipt_mismatch" });
    expect(records).toHaveLength(2);
    expect(records.join("\n")).not.toContain("private-other-worker");
    expect(records.join("\n")).not.toContain(saved.cert_id);
    expect(records.join("\n")).not.toContain(saved.id);
  } finally { logger.mockRestore(); f.close(); }
});

test("Cloudflare error logs identify transport, HTTP, body, JSON and envelope boundaries without raw exceptions or bodies", async () => {
  const f = await sqliteServiceFixture(), records: string[] = [], secret = "private-transport-or-response";
  const logger = spyOn(console, "error").mockImplementation((line) => { records.push(String(line)); });
  try {
    const cases: Array<{ reason: string; respond: () => Response }> = [
      { reason: "transport_unverified", respond: () => { throw new Error(secret); } },
      { reason: "http_status_unverified", respond: () => new Response(secret, { status: 403 }) },
      { reason: "body_missing", respond: () => new Response(null) },
      { reason: "partial_response_unverified", respond: () => new Response(secret, { headers: { "Content-Range": "bytes 0-1/2" } }) },
      { reason: "body_unverified", respond: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } })) },
      { reason: "json_unverified", respond: () => new Response(secret) },
      { reason: "envelope_unverified", respond: () => Response.json({ success: false, errors: [{ message: secret }] }) },
    ];
    for (const item of cases) {
      let calls = 0;
      const api = new SqliteDomainCloudflare(f.config, { ...f.options, transport: async () => { calls++; return item.respond(); } });
      const count = records.length;
      await expect(api.list()).rejects.toThrow();
      expect(calls).toBe(1); expect(records).toHaveLength(count + 1);
      expect(JSON.parse(records.at(-1)!)).toMatchObject({ event: "sqlite_domain_cloudflare", api_operation: "domain_list", method: "GET", reason_code: item.reason, will_retry: false });
    }
    expect(records.join("\n")).not.toContain(secret);
    expect(records.join("\n")).not.toContain("private-token");
    expect(records.join("\n")).not.toContain("api.cloudflare.com");
  } finally { logger.mockRestore(); f.close(); }
});
