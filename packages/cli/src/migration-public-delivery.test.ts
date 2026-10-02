import { expect, test } from "bun:test";
import { frozenMigrationPlanSchema, parseServiceConfig, serviceConfigSchema } from "@castloop/shared";
import type { FrozenMigrationPlan, LifecycleState } from "@castloop/shared";
import { beginBootstrapDeployment, prepareBootstrapDeployment, settleBootstrapDeployment } from "../../../src/migration-bootstrap";
import { readServiceAdmission } from "../../../src/service-admission";
import { bootstrapFixture } from "../../../src/test-support/bootstrap";
import { inspectMigrationPublicDelivery } from "./migration-public-delivery";
import type { MigrationPublicTransport } from "./migration-public-delivery";
import { createHash } from "node:crypto";

function show(showId: string, lifecycle: LifecycleState, episodes: Array<[string, LifecycleState]> = []): FrozenMigrationPlan["shows"][number] {
  return { show_id: showId, mode: "preserve", value: { schema_version: 2, show_id: showId, lifecycle, generation: 0, feed_generation: 0 },
    episodes: episodes.map(([episodeId, state]) => ({ episode_id: episodeId, mode: "preserve",
      value: { schema_version: 1, show_id: showId, episode_id: episodeId, lifecycle: state, generation: 0 } })) };
}

function fixture() {
  const config = serviceConfigSchema.parse({ schema_version: 1, service_id: "service", account_id: "a".repeat(32),
    bucket_name: "private-service", worker_name: "service-worker", queue_name: "service-queue", dlq_name: "service-dlq",
    public_base_url: "https://public.example" });
  const versionId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const keys = ["public/podcasts/daily/feed.xml", "public/podcasts/daily/cover.png",
    `public/podcasts/daily/episodes/first/${revisionId}.mp3`, `public/podcasts/daily/episodes/stopped/${revisionId}.mp3`,
    `public/podcasts/daily/episodes/deleted/${revisionId}.mp3`, "public/podcasts/stopped/feed.xml", "public/podcasts/deleted/cover.jpg"];
  const plan = frozenMigrationPlanSchema.parse({ schema_version: 1, service_id: "service", migration_id: crypto.randomUUID(),
    request_sha256: "a".repeat(64), sources: [...keys.map((key) => ({ key, etag: "frozen-etag", size: 300000000 })),
      { key: "system/service.toml", etag: "private-etag", size: 200 },
      { key: "public/episodes/daily/first/metadata.toml", etag: "private-etag", size: 200 }],
    shows: [show("daily", "active", [["first", "active"], ["stopped", "unpublished"], ["deleted", "deleted"]]),
      show("stopped", "unpublished"), show("deleted", "deleted")] });
  const calls: Request[] = [];
  let cancelled = 0;
  const transport: MigrationPublicTransport = async (url, init) => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const request = new Request(url, init);
    calls.push(request);
    const path = new URL(url).pathname;
    const hidden = path.includes("/deleted/") ? 410 : path.includes("/stopped/") ? 404 : 200;
    const status = hidden !== 200 ? hidden : request.headers.has("Range") ? 206 : request.headers.has("If-None-Match") ? 304 : 200;
    const headers = { "X-Castloop-Worker-Version": versionId, "X-Castloop-Migration-ID": plan.migration_id,
      "Cache-Control": hidden === 200 ? "public, max-age=0, must-revalidate" : "no-store",
      ...(hidden === 200 ? { ETag: '"frozen-etag"', "Content-Length": status === 206 ? "1" : "300000000" } : {}),
      ...(status === 206 ? { "Content-Range": "bytes 0-0/300000000" } : {}) };
    const body = request.method === "HEAD" || status === 304 ? null : status === 206 ? new Uint8Array([7]) :
      new ReadableStream<Uint8Array>({ pull() { throw new Error("Must cancel unbounded GET/error body without reading it"); },
        cancel() { cancelled += 1; } }, { highWaterMark: 0 });
    return new Response(body, { status, headers });
  };
  return { config, plan, versionId, keys, calls, transport, cancelled: () => cancelled };
}

test("external public HTTP inspection checks exact frozen paths, lifecycle status and transport without credentials or writes", async () => {
  const setup = fixture();
  const before = JSON.stringify({ config: setup.config, plan: setup.plan });
  const result = await inspectMigrationPublicDelivery(setup.config, setup.plan, setup.versionId, { maximumAssets: 20, transport: setup.transport });
  expect(result).toMatchObject({ schema_version: 1, service_id: "service", migration_id: setup.plan.migration_id,
    worker_version_id: setup.versionId, public_origin: setup.config.public_base_url,
    first_asset: 0, next_asset: 7, total_assets: 7, assets_checked: 7,
    snapshot_only: true, authorizes_completion: false, authorizes_mutation: false, payloads_verified: false, routing_scope_verified: false });
  expect(result.plan_sha256).toBe(createHash("sha256").update(JSON.stringify(setup.plan)).digest("hex"));
  expect(result.checks_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(setup.calls.map((request) => request.method)).toEqual(setup.keys.flatMap(() => ["HEAD", "GET", "GET", "GET"]));
  for (let index = 0; index < setup.calls.length; index += 1) {
    const request = setup.calls[index]!;
    expect(request.url).toBe(`https://public.example${setup.keys[Math.floor(index / 4)]!.slice(6)}`);
    expect([...request.headers.keys()].sort()).toEqual(index % 4 === 2 ? ["accept-encoding", "range"] :
      index % 4 === 3 ? ["accept-encoding", "if-none-match"] : ["accept-encoding"]);
    expect(request.headers.get("Accept-Encoding")).toBe("identity");
  }
  expect(setup.cancelled()).toBe(15);
  expect(JSON.stringify({ config: setup.config, plan: setup.plan })).toBe(before);
  expect(JSON.stringify(result)).not.toContain("frozen-etag");
  expect(JSON.stringify(result)).not.toContain("system/");
});

test("inspection uses bounded deterministic pages and distinguishes zero inspected assets from completed migration", async () => {
  const setup = fixture();
  const first = await inspectMigrationPublicDelivery(setup.config, setup.plan, setup.versionId, { transport: setup.transport });
  expect(first.next_asset).toBe(2);
  expect(setup.calls).toHaveLength(8);
  const second = await inspectMigrationPublicDelivery(setup.config, setup.plan, setup.versionId,
    { firstAsset: first.next_asset, maximumAssets: 1, transport: setup.transport });
  expect(second.first_asset).toBe(2);
  expect(second.next_asset).toBe(3);
  expect(second.assets_checked).toBe(1);
  expect(second.plan_sha256).toBe(first.plan_sha256);
  const end = await inspectMigrationPublicDelivery(setup.config, setup.plan, setup.versionId,
    { firstAsset: 7, transport: setup.transport });
  expect(end.assets_checked).toBe(0);
  expect(end.authorizes_completion).toBe(false);
  expect(setup.calls).toHaveLength(12);
});

test("external adapter traverses the real candidate gateway without changing bootstrap, registry or readiness", async () => {
  const setup = await bootstrapFixture(true, "https://public.example");
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const transport: MigrationPublicTransport = (url, init) => setup.candidate.defaultFetch!(new Request(url, init));
  await expect(inspectMigrationPublicDelivery(config, setup.plan!, setup.candidateVersion, { transport })).rejects.toThrow("no mutation or completion");
  expect(setup.calls).toHaveLength(1);
  await setup.run((execution) => prepareBootstrapDeployment(setup.env, execution, setup.bootstrapRequest, setup.bridge));
  await setup.run((execution) => beginBootstrapDeployment(setup.env, execution, setup.bootstrapRequest.bootstrap_id, setup.bridge));
  await setup.run((execution) => settleBootstrapDeployment(setup.env, execution, setup.settlement, setup.candidate));
  const before = JSON.stringify([...setup.entries]);
  const result = await inspectMigrationPublicDelivery(config, setup.plan!, setup.candidateVersion, { maximumAssets: 20, transport });
  expect(result.assets_checked).toBe(3);
  expect(result.authorizes_completion).toBe(false);
  expect(result.routing_scope_verified).toBe(false);
  expect(setup.calls).toHaveLength(13);
  expect(JSON.stringify([...setup.entries])).toBe(before);
  const admission = (await readServiceAdmission(setup.env, "service"))!.value;
  expect(admission.state).toBe("migrating");
  expect(admission.invocations).toEqual([]);
  expect(admission.readiness).toBeUndefined();
  expect(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data).phase).toBe("verifying");
});

test("inspection owns response cancellation until it settles and never advances while old response IO is live", async () => {
  const setup = fixture();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const cancelling = new Promise<void>((resolve) => { started = resolve; });
  let settled = false;
  const transport: MigrationPublicTransport = async (url, init) => {
    const response = await setup.transport(url, init);
    if (init.method !== "GET" || new Headers(init.headers).has("Range") || new Headers(init.headers).has("If-None-Match")) return response;
    await response.body?.cancel();
    return new Response(new ReadableStream<Uint8Array>({ async cancel() {
      started();
      await blocked;
      settled = true;
    } }), { status: response.status, headers: response.headers });
  };
  const pending = inspectMigrationPublicDelivery(setup.config, setup.plan, setup.versionId, { maximumAssets: 1, transport });
  await cancelling;
  expect(settled).toBe(false);
  expect(setup.calls).toHaveLength(2);
  release();
  expect((await pending).assets_checked).toBe(1);
  expect(settled).toBe(true);
  expect(setup.calls).toHaveLength(4);
});

test("foreign service, non-origin URL, unknown/missing target and invalid pages fail before HTTP", async () => {
  const setup = fixture();
  const reject = (config = setup.config, plan = setup.plan, options = {}) =>
    expect(inspectMigrationPublicDelivery(config, plan, setup.versionId, { ...options, transport: setup.transport })).rejects.toThrow("no mutation or completion");
  await reject({ ...setup.config, service_id: "foreign" });
  for (const suffix of ["/path", "/?secret=private", "/#secret"]) await reject({ ...setup.config, public_base_url: `https://public.example${suffix}` });
  await reject(setup.config, { ...setup.plan, shows: setup.plan.shows.slice(1) });
  await reject(setup.config, { ...setup.plan, sources: [{ key: "system/secrets.json", etag: "x", size: 1 }] });
  await reject(setup.config, { ...setup.plan, sources: [{ ...setup.plan.sources[0]!, size: 0 }] });
  await expect(inspectMigrationPublicDelivery(setup.config, setup.plan, "invalid-version", { transport: setup.transport })).rejects.toThrow("no mutation or completion");
  for (const options of [{ firstAsset: -1 }, { firstAsset: 8 }, { firstAsset: 0.5 }, { maximumAssets: 0 }, { maximumAssets: 21 }]) {
    await reject(setup.config, setup.plan, options);
  }
  expect(setup.calls).toEqual([]);
});

for (const fault of ["status", "version", "migration", "cache", "etag", "length", "encoding", "range", "short", "long", "endless", "conditional", "redirect", "wrong-url", "cancel", "transport"] as const) {
  test(`external HTTP ${fault} failure is fixed-diagnostic, awaited and never retried`, async () => {
    const setup = fixture();
    let requests = 0;
    let cancelled = false;
    const transport: MigrationPublicTransport = async (url, init) => {
      requests += 1;
      if (fault === "transport") throw new Error("private-key arbitrary transport detail");
      const response = await setup.transport(url, init);
      const isRange = new Headers(init.headers).has("Range");
      if (["range", "short", "long", "endless"].includes(fault) && !isRange) return response;
      if (fault === "conditional" && !new Headers(init.headers).has("If-None-Match")) return response;
      await response.body?.cancel();
      const headers = new Headers(response.headers);
      if (fault === "version") headers.set("X-Castloop-Worker-Version", crypto.randomUUID());
      if (fault === "migration") headers.set("X-Castloop-Migration-ID", crypto.randomUUID());
      if (fault === "cache") headers.set("Cache-Control", "public, max-age=300");
      if (fault === "etag") headers.set("ETag", '"other"');
      if (fault === "length") headers.set("Content-Length", "1");
      if (fault === "encoding") headers.set("Content-Encoding", "gzip");
      if (fault === "range") headers.set("Content-Range", "bytes 0-1/300000000");
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        if (fault === "short") controller.close();
        else controller.enqueue(new Uint8Array(fault === "long" ? 2 : 1));
        if (fault !== "long" && fault !== "short" && fault !== "cancel" && fault !== "endless") controller.close();
      }, pull(controller) { if (fault === "endless") controller.enqueue(new Uint8Array()); }, async cancel() {
        await Promise.resolve();
        cancelled = true;
        if (fault === "cancel") throw new Error("private cancellation failure");
      } });
      const result = new Response(body, { status: fault === "status" ? 503 : fault === "conditional" ? 200 : response.status, headers });
      if (fault === "redirect") Object.defineProperty(result, "redirected", { value: true });
      if (fault === "wrong-url") Object.defineProperty(result, "url", { value: "https://foreign.example/private" });
      return result;
    };
    await expect(inspectMigrationPublicDelivery(setup.config, setup.plan, setup.versionId, { transport })).rejects.toThrow(
      "Migration public HTTP inspection failed; no mutation or completion is authorized");
    expect(requests).toBe(["range", "long", "short", "endless"].includes(fault) ? 3 : fault === "conditional" ? 4 : 1);
    if (["range", "long", "endless", "cancel"].includes(fault)) expect(cancelled).toBe(true);
  });
}
