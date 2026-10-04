import { expect, test } from "bun:test";
import { m6SetupCompletedSchema, m6SetupRecordSchema, m6SetupStatusSchema } from "../packages/shared/src/index";
import { fetchM6Candidate } from "./m6-routes";
import { consumeM6SetupProbe } from "./m6-setup-queue";
import { m6SetupRecordKey } from "./m6-setup-record";
import { readServiceAdmission, resumeServiceAdmission } from "./service-admission";
import { m6SetupFixture as fixture } from "./test-support/m6-setup";

test("authenticated setup verifies live loopbacks and its Queue receipt, finishes paused and leaves the normal candidate closed", async () => {
  const setup = await fixture();
  expect((await setup.run(setup.post("prepare", setup.request, "wrong-key"))).status).toBe(401);
  expect(setup.sent).toHaveLength(0);
  expect(setup.purges).toHaveLength(0);
  expect((await setup.run(setup.post("prepare", setup.request))).status).toBe(200);
  expect(setup.purges).toHaveLength(1);
  expect(setup.sent).toHaveLength(1);
  const input = { ...setup.request, snapshots: [setup.snapshot, setup.snapshot] };
  expect((await setup.run(setup.post("complete", input))).status).toBe(409);
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("initializing");
  await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
  const completed = await setup.run(setup.post("complete", input));
  expect(completed.status).toBe(200);
  const receipt = m6SetupCompletedSchema.parse(await completed.json<unknown>());
  expect(receipt.request).toEqual(setup.request);
  expect(receipt.readiness.worker_version_id).toBe(setup.versionId);
  expect(setup.calls.filter((path) => path === "/admin/setup/probe")).toHaveLength(2);
  expect(setup.calls).toContain("/admin/publication");
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
  expect([...setup.entries.keys()].sort()).toEqual(["system/service.toml", "system/lifecycle-service.json", m6SetupRecordKey(setup.request.target.operation_id)].sort());
  const before = [...setup.writes];
  const sent = [...setup.sent];
  expect((await setup.run(setup.post("prepare", setup.request))).status).toBe(200);
  expect((await setup.run(setup.post("complete", input))).status).toBe(200);
  expect(setup.writes).toEqual(before);
  expect(setup.sent).toEqual(sent);
  expect((await fetchM6Candidate(setup.post("prepare", setup.request), setup.env, setup.assets)).status).toBe(409);
  await resumeServiceAdmission(setup.env, setup.config.service_id, setup.request.target.operation_id);
  const resumed = [...setup.writes];
  await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
  expect(setup.writes).toEqual(resumed);
});

test("setup refuses body flags, missing routes, method changes and another permanent target without admitting content writes", async () => {
  const setup = await fixture();
  expect((await setup.run(setup.post("prepare", { ...setup.request, ready: true }))).status).toBe(400);
  expect((await setup.run(setup.post("unknown", setup.request))).status).toBe(404);
  expect((await setup.run(new Request(`${setup.config.public_base_url}/admin/setup/prepare`, { headers: { "X-Castloop-Key": "private-secret" } }))).status).toBe(405);
  await setup.run(setup.post("prepare", setup.request));
  const before = new Map(setup.entries);
  expect((await setup.run(setup.post("prepare", { target: { ...setup.request.target, deployment_id: crypto.randomUUID() } }))).status).toBe(409);
  expect((await setup.run(setup.post("complete", { ...setup.request, readiness: { cutover_verified: true } }))).status).toBe(400);
  expect(setup.entries).toEqual(before);
});

test("foreign Queue, version or target cannot manufacture a runtime receipt; exact duplicate receipts do not write", async () => {
  const setup = await fixture();
  await setup.run(setup.post("prepare", setup.request));
  const body = setup.sent[0];
  const before = new Map(setup.entries);
  await expect(consumeM6SetupProbe(setup.batch(body, setup.config.dlq_name), setup.env)).rejects.toThrow("another Queue");
  await expect(consumeM6SetupProbe(setup.batch({ ...(body as object), target: { ...setup.request.target, deployment_id: crypto.randomUUID() } }), setup.env)).rejects.toThrow("permanent request");
  await expect(consumeM6SetupProbe(setup.batch(body), { ...setup.env, CASTLOOP_VERSION_METADATA: { id: crypto.randomUUID() } })).rejects.toThrow("Worker version");
  expect(setup.entries).toEqual(before);
  expect(await consumeM6SetupProbe(setup.batch({ unknown: true }), setup.env)).toBe(false);
  await consumeM6SetupProbe(setup.batch(body), setup.env);
  const after = [...setup.writes];
  await consumeM6SetupProbe(setup.batch(body), setup.env);
  expect(setup.writes).toEqual(after);
});

test("failed or cached HTTP checks, wrong cache owners and changed REST snapshots retain initializing admission", async () => {
  for (const failure of ["cached", "cache-owner", "route", "http", "rest"] as const) {
    const setup = await fixture();
    await setup.run(setup.post("prepare", setup.request));
    await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
    const original = setup.runtime.defaultFetch;
    let cached: Response | undefined;
    if (failure === "cache-owner") setup.runtime.cachedRuntime = async () => ({ worker_version_id: crypto.randomUUID() });
    else setup.runtime.defaultFetch = async (input) => {
      if (failure === "http") return new Response("failure", { status: 503 });
      if (failure === "route" && new URL(input.url).pathname === "/admin/publication") return Response.json({ reason_code: "unsupported" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      if (failure === "cached" && new URL(input.url).pathname === "/admin/setup/probe") {
        cached ??= await original(input);
        return cached.clone();
      }
      return original(input);
    };
    const changed = structuredClone(setup.snapshot);
    if (failure === "rest") changed.settings[1].cache_options!.cross_version_cache = true;
    expect((await setup.run(setup.post("complete", { ...setup.request, snapshots: [setup.snapshot, changed] }))).status).toBe(409);
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("initializing");
  }
});

test("a lost Queue send acknowledgement keeps the pending probe and does not blindly resend on prepare", async () => {
  const setup = await fixture();
  setup.env.CASTLOOP_QUEUE.send = async () => { throw new Error("Queue response lost"); };
  expect((await setup.run(setup.post("prepare", setup.request))).status).toBe(409);
  const record = m6SetupRecordSchema.parse(JSON.parse(setup.text(m6SetupRecordKey(setup.request.target.operation_id))!));
  expect(record.queue_receipt).toBeUndefined();
  const before = [...setup.writes];
  expect((await setup.run(setup.post("prepare", setup.request))).status).toBe(200);
  const status = await setup.run(setup.post("status", setup.request));
  expect(m6SetupStatusSchema.parse(await status.json<unknown>()).record).toEqual(record);
  expect(setup.writes).toEqual(before);
});
