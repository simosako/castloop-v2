import { afterEach, expect, test } from "bun:test";
import { initializeSqliteService } from "./sqlite-initialization";
import { continueSqliteServiceUpdateVerification, readSqliteServiceUpdate, reconcileSqliteServiceUpdate, updateSqliteService } from "./sqlite-service-update";
import { runSqliteCommand } from "./sqlite-commands";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
const wait = { attempts: 2, delay: async () => {} };

test("Show/Episode read-boundary and cover storage formats are required before preparing or deploying an update", async () => {
  for (const [field, marker] of [["publication_read_boundary", undefined], ["publication_read_boundary", "episode-revision-v1"],
    ["publication_read_boundary", "unknown"], ["cover_storage", undefined], ["cover_storage", "fixed-key-v1"]] as const) {
    const { value, id } = await fixture();
    value.calls.length = 0;
    const transport: typeof value.transport = async (input, init) => {
      const response = await value.transport(input, init);
      if (new URL(input instanceof Request ? input.url : input).pathname.endsWith("/health")) {
        const body = await response.json() as Record<string, unknown>;
        if (marker === undefined) delete body[field];
        else body[field] = marker;
        return new Response(JSON.stringify(body), { headers: response.headers });
      }
      return response;
    };
    await expect(updateSqliteService(value.root, value.config, id, "new source", { ...value.options, transport }, wait)).rejects.toThrow();
    expect(value.calls.every((call) => call.method === "GET")).toBe(true);
    expect(readSqliteServiceUpdate(value.root, value.config, id)).toBeNull();
  }
});
async function fixture() {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "initial source", value.options, wait);
  const id = crypto.randomUUID();
  const update = (source = "new source", operationId = id) => updateSqliteService(value.root, value.config, operationId, source, value.options, wait);
  return { value, id, update };
}

test("compatible REST updates preserve the namespace/content, finish paused after a new probe and require explicit resume", async () => {
  const { value, id, update } = await fixture(), oldVersion = value.runtime.health().worker_version_id;
  const command = (name: string, args: string[] = []) => runSqliteCommand(value.root, value.config, name, args, { transport: value.transport, cloudflare: value.options });
  await command("create-show", ["daily", "https://example.com/podcast"]); await command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
  await command("update-show", ["daily"]); await command("publish-show", ["daily"]);
  await command("create-episode", ["daily", "first"]);
  writeFileSync(join(value.root, "daily", "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await command("update-episode", ["daily", "first"]); await command("update-episode-audio", ["daily", "first", "audio.mp3"]); await command("publish-episode", ["daily", "first"]);
  const preserved = new Map([...value.entries].map(([key, object]) => [key, object.etag]));
  await command("show-pause", ["daily", crypto.randomUUID()]); value.calls.length = 0;
  const result = await update(); expect(result.phase).toBe("ready"); expect(result.receipt!.worker_version_id).not.toBe(oldVersion);
  expect(value.runtime.health()).toMatchObject({ publication_ready: true, state: "paused", drained: true,
    runtime_update: { operation_id: id, state: "completed" } });
  expect(value.content.episodes("daily")).toHaveLength(1);
  for (const [key, etag] of preserved) expect(value.entries.get(key)!.etag).toBe(etag);
  const mutations = value.calls.filter((call) => call.method !== "GET");
  expect(mutations).toHaveLength(3); expect(mutations.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(mutations.some((call) => /r2|subdomain|queues|namespaces/.test(call.path))).toBe(false);
  expect(value.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
  await command("show-resume", ["daily", crypto.randomUUID()]);
  const file = join(value.root, "daily", "episode-first.toml"); writeFileSync(file, readFileSync(file, "utf8").replace('title = "first"', 'title = "After compatible update"'));
  await command("update-episode", ["daily", "first"]); expect(await command("publish-episode", ["daily", "first"])).toMatchObject({ state: "succeeded" });
  expect(value.content.episodes("daily")[0].title).toBe("After compatible update");
  const journal = readFileSync(join(value.root, ".castloop", "sqlite-service-updates", value.config.service_id, `${id}.json`), "utf8");
  expect(journal).not.toContain("new source"); expect(journal).not.toContain("private-token"); expect(journal).not.toContain("CASTLOOP_ADMIN_KEY");
});

for (const format of [undefined, "fixed-key-v1"]) {
  test(`incompatible Feed storage ${format ?? "missing"} is refused before update preparation or deployment`, async () => {
    const { value } = await fixture(); value.calls.length = 0;
    await expect(updateSqliteService(value.root, value.config, crypto.randomUUID(), "new source", {
      ...value.options, transport: async (input, init) => {
        const response = await value.transport(input, init);
        if (new URL(String(input)).pathname.endsWith("/health")) {
          const body = await response.json() as Record<string, unknown>;
          delete body.feed_storage;
          if (format !== undefined) body.feed_storage = format;
          return Response.json(body);
        }
        return response;
      },
    }, wait)).rejects.toThrow();
    expect(value.calls.every((call) => call.method === "GET")).toBe(true);
    expect(value.showCalls).toEqual([]);
  });
}

for (const lost of ["update-prepare", "deploy"] as const) {
  test(`unknown ${lost} outcome is never resent or adopted from REST`, async () => {
    const { value, id, update } = await fixture(); value.faults.lost = lost;
    await expect(update()).rejects.toThrow();
    expect(readSqliteServiceUpdate(value.root, value.config, id)!.phase).toBe(lost === "deploy" ? "deploy_requested" : "prepare_requested");
    const count = value.calls.length; value.faults.lost = undefined;
    await expect(update()).rejects.toThrow("already started"); expect(value.calls).toHaveLength(count);
    await expect(update("changed source")).rejects.toThrow("frozen"); expect(value.calls).toHaveLength(count);
    await expect(reconcileSqliteServiceUpdate(value.root, value.config, id, value.options)).rejects.toThrow("no completed-runtime");
    expect(value.calls).toHaveLength(count); expect(value.runtime.ready()).toBe(false);
  });
}

test("lost activation is verified by read-only completion without another activation POST", async () => {
  const { value, update } = await fixture(); value.faults.lost = "activation";
  expect((await update()).phase).toBe("ready");
  expect(value.calls.filter((call) => call.method === "POST" && call.path.endsWith("update-activate"))).toHaveLength(1);
});

test("pending updated probes can only reconcile already-completed matching setup using GET requests", async () => {
  const { value, id, update } = await fixture(); value.faults.deferUpdateProbe = true;
  await expect(update()).rejects.toThrow("remains unconfirmed");
  expect(readSqliteServiceUpdate(value.root, value.config, id)!.phase).toBe("activation_requested");
  await expect(reconcileSqliteServiceUpdate(value.root, value.config, id, value.options)).rejects.toThrow("not verified");
  value.clearAlarm(); await value.runtime.alarm(); await value.control.progress(); value.calls.length = 0;
  expect((await reconcileSqliteServiceUpdate(value.root, value.config, id, value.options)).phase).toBe("ready");
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});

test("blocked probes and changed namespaces cannot be promoted to ready", async () => {
  const blocked = await fixture(); blocked.value.faults.failPurge = true;
  await expect(blocked.update()).rejects.toThrow("blocked");
  expect(blocked.value.runtime.health().runtime_update?.state).toBe("blocked");
  await expect(reconcileSqliteServiceUpdate(blocked.value.root, blocked.value.config, blocked.id, blocked.value.options)).rejects.toThrow();
  const drift = await fixture(); drift.value.faults.afterDeploy = () => { drift.value.faults.namespace = true; };
  await expect(drift.update()).rejects.toThrow("namespace");
  expect(drift.value.calls.some((call) => call.path.endsWith("update-activate"))).toBe(false);
  expect(drift.value.runtime.ready()).toBe(false);
});

test("open Shows refuse deployment, and successive completed code updates retain independent evidence", async () => {
  const { value, update } = await fixture();
  await runSqliteCommand(value.root, value.config, "create-show", ["daily", "https://example.com"], { transport: value.transport, cloudflare: value.options });
  value.queue.resume(crypto.randomUUID()); value.calls.length = 0;
  await expect(update()).rejects.toThrow("pause and drain"); expect(value.calls.every((call) => call.method === "GET")).toBe(true);
  value.queue.pause(); const first = await update();
  const second = await update("next compatible source", crypto.randomUUID());
  expect(second.receipt!.worker_version_id).not.toBe(first.receipt!.worker_version_id);
  expect(value.runtime.health()).toMatchObject({ publication_ready: true, state: "paused" });
});

test("acknowledged old native versions are observed finitely without replaying deployment or activation", async () => {
  const { value, id } = await fixture(), oldVersion = value.runtime.health().worker_version_id;
  value.calls.length = 0;
  let oldReplies = 2, waits = 0;
  const transport: typeof value.transport = async (input, init) => {
    const response = await value.transport(input, init);
    if (new URL(input instanceof Request ? input.url : input).pathname.includes("/update-status/") && oldReplies-- > 0) {
      const body = await response.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, worker_version_id: oldVersion }), { headers: response.headers });
    }
    return response;
  };
  const result = await updateSqliteService(value.root, value.config, id, "new source", { ...value.options, transport },
    { attempts: 3, delay: async () => { waits++; } });
  expect(result.phase).toBe("ready"); expect(waits).toBe(2);
  expect(value.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(value.calls.filter((call) => call.path.endsWith("update-prepare") && call.method === "POST")).toHaveLength(1);
  expect(value.calls.filter((call) => call.path.endsWith("update-activate") && call.method === "POST")).toHaveLength(1);
});

test("verified unactivated deployments explicitly continue only the first activation with frozen inputs", async () => {
  const { value, id } = await fixture(), oldVersion = value.runtime.health().worker_version_id;
  let stale = true;
  const transport: typeof value.transport = async (input, init) => {
    const response = await value.transport(input, init);
    if (stale && new URL(input instanceof Request ? input.url : input).pathname.includes("/update-status/")) {
      const body = await response.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, worker_version_id: oldVersion }), { headers: response.headers });
    }
    return response;
  };
  const options = { ...value.options, transport };
  await expect(updateSqliteService(value.root, value.config, id, "new source", options, wait)).rejects.toThrow("continue verification");
  expect(readSqliteServiceUpdate(value.root, value.config, id)?.phase).toBe("verified");
  expect(value.calls.some((call) => call.path.endsWith("update-activate"))).toBe(false);
  value.calls.length = 0;
  await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "changed", options, wait)).rejects.toThrow("exact verified");
  expect(value.calls).toHaveLength(0); stale = false;
  const result = await runSqliteCommand(value.root, value.config, "update-service-verify", [id], {
    workerSource: async () => "new source", cloudflare: options, transport });
  expect(result).toMatchObject({ phase: "ready" });
  const mutations = value.calls.filter((call) => call.method !== "GET");
  expect(mutations).toHaveLength(1); expect(mutations[0].path.endsWith("update-activate")).toBe(true);
  value.calls.length = 0;
  await expect(continueSqliteServiceUpdateVerification(value.root, value.config, id, "new source", options, wait)).rejects.toThrow("no prior activation");
  expect(value.calls).toHaveLength(0);
});

test("unknown native versions are not adopted and prior activation requests cannot be continued", async () => {
  const { value, id } = await fixture();
  const transport: typeof value.transport = async (input, init) => {
    const response = await value.transport(input, init);
    if (new URL(input instanceof Request ? input.url : input).pathname.includes("/update-status/")) {
      const body = await response.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, worker_version_id: crypto.randomUUID() }), { headers: response.headers });
    }
    return response;
  };
  await expect(updateSqliteService(value.root, value.config, id, "new source", { ...value.options, transport }, wait)).rejects.toThrow("exact maintenance");
  expect(readSqliteServiceUpdate(value.root, value.config, id)?.phase).toBe("verified");
  expect(value.calls.some((call) => call.path.endsWith("update-activate"))).toBe(false);
  const pending = await fixture(); pending.value.faults.deferUpdateProbe = true;
  await expect(pending.update()).rejects.toThrow("remains unconfirmed"); pending.value.calls.length = 0;
  await expect(continueSqliteServiceUpdateVerification(pending.value.root, pending.value.config, pending.id, "new source", pending.value.options, wait)).rejects.toThrow("no prior activation");
  expect(pending.value.calls).toHaveLength(0);
});
