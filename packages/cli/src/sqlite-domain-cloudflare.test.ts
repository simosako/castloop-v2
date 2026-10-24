import { expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { SqliteDomainCloudflare } from "./sqlite-domain-cloudflare";

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
