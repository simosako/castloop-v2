import { expect, test } from "bun:test";
import bridgeWorker from "./migration-bridge-worker";
import { bootstrapFixture } from "./test-support/bootstrap";

test("bridge has authenticated migration routes but no cacheable legacy public/admin responses", async () => {
  const setup = await bootstrapFixture(false);
  const env = { ...setup.env, CASTLOOP_VERSION_METADATA: { ...setup.env.CASTLOOP_VERSION_METADATA, id: setup.bridgeVersion } };
  const ctx = { cache: { purge: async () => ({ success: true, errors: [] }) } } as never;
  const response = await bridgeWorker.fetch(new Request("https://current.example/podcasts/daily/feed.xml"), env, ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
  expect(response.headers.get("Cache-Tag")).toBeNull();
  expect(response.headers.get("X-Castloop-Worker-Version")).toBe(setup.bridgeVersion);
  expect(await response.text()).toBe("legacy feed");
  const status = await bridgeWorker.fetch(new Request("https://current.example/admin/migration/status", {
    headers: { "X-Castloop-Key": "private-key" },
  }), env, ctx);
  expect(status.status).toBe(200);
  expect(status.headers.get("Cache-Control")).toBe("no-store");
  expect((await bridgeWorker.fetch(new Request("https://current.example/admin/migration/status"), env, ctx)).status).toBe(401);
});

test("bridge refuses legacy public delivery after the plan has frozen; status remains inspectable", async () => {
  const setup = await bootstrapFixture();
  const env = { ...setup.env, CASTLOOP_VERSION_METADATA: { ...setup.env.CASTLOOP_VERSION_METADATA, id: setup.bridgeVersion } };
  const response = await bridgeWorker.fetch(new Request("https://current.example/podcasts/daily/feed.xml"), env, {} as never);
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const status = await bridgeWorker.fetch(new Request("https://current.example/admin/migration/status", {
    headers: { "X-Castloop-Key": "private-key" },
  }), env, {} as never);
  expect(status.status).toBe(200);
  expect(await status.text()).toContain('"m6_ready":false');
});
