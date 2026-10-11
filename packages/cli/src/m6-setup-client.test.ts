import { expect, test } from "bun:test";
import { m6ServiceAdminResponseSchema, m6SetupStatusSchema } from "@castloop/shared";
import { M6SetupClient } from "./m6-setup-client";
import { consumeM6SetupProbe } from "../../../src/m6-setup-queue";
import { readServiceAdmission } from "../../../src/service-admission";
import { m6SetupFixture } from "../../../src/test-support/m6-setup";

test("setup client brackets authenticated HTTP/Queue checks with sanitized REST observations and finishes paused", async () => {
  const setup = await m6SetupFixture();
  const calls: string[] = [];
  const client = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => {
    calls.push("rest"); return setup.snapshot;
  } }, async (url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(String(init.body)).not.toContain("private-secret");
    return setup.run(new Request(url, init));
  });
  const readiness = await client.initialize(setup.request.target, { maximumReads: 2, delay: async () => {
    await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
  } });
  expect(readiness.worker_version_id).toBe(setup.versionId);
  expect(calls).toEqual(["rest", "GET /admin/health", "POST /admin/setup/prepare", "POST /admin/setup/status", "GET /admin/setup/probe", "GET /admin/setup/probe", "rest", "POST /admin/setup/complete"]);
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
  expect(setup.sent).toHaveLength(1);
});

test("pending Queue observations and unknown HTTP outcomes never resend prepare or release initialization ownership", async () => {
  for (const failure of ["pending", "prepare", "complete"] as const) {
    const setup = await m6SetupFixture();
    const calls: string[] = [];
    const client = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot }, async (url, init) => {
      calls.push(url.pathname);
      const response = await setup.run(new Request(url, init));
      if (url.pathname.endsWith(`/${failure}`)) { await response.body?.cancel(); throw new Error("Acknowledgement lost"); }
      return response;
    });
    await expect(client.initialize(setup.request.target, { maximumReads: 2, delay: async () => {
      if (failure !== "pending") await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
    } })).rejects.toThrow(failure === "pending" ? "still pending" : "outcome is unknown");
    expect(calls.filter((path) => path.endsWith("/prepare"))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith("/complete"))).toHaveLength(failure === "complete" ? 1 : 0);
    expect(setup.sent).toHaveLength(1);
    const admission = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
    expect(admission.state).toBe(failure === "complete" ? "paused" : "initializing");
    expect(admission.invocations).toHaveLength(0);
    const writes = setup.writes.length;
    const sent = setup.sent.length;
    if (failure === "complete") expect(await client.observeCompleted(setup.request)).toEqual(admission.runtime_readiness!);
    else await expect(client.observeCompleted(setup.request)).rejects.toThrow("already-completed paused");
    expect(setup.writes).toHaveLength(writes);
    expect(setup.sent).toHaveLength(sent);
  }
});

test("completion reconciliation rejects missing/foreign receipts, another pause, live tokens and changing admission without writes", async () => {
  for (const failure of ["receipt", "foreign", "pause", "live", "changing"] as const) {
    const setup = await m6SetupFixture();
    const original = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot },
      (url, init) => setup.run(new Request(url, init)));
    await original.initialize(setup.request.target, { maximumReads: 1, delay: async () => { await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env); } });
    let serviceReads = 0;
    const client = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot }, async (url, init) => {
      const response = await setup.run(new Request(url, init));
      if (url.pathname.endsWith("/service")) {
        const body = m6ServiceAdminResponseSchema.parse(await response.json());
        serviceReads++;
        if (failure === "pause") body.admission.pause_id = crypto.randomUUID();
        if (failure === "live") body.admission.invocations.push({ token: crypto.randomUUID(), kind: "m6_consumer" });
        if (failure === "changing" && serviceReads === 2) body.admission.generation++;
        return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      }
      const body = m6SetupStatusSchema.parse(await response.json());
      if (failure === "receipt") delete body.record.queue_receipt;
      else if (failure === "foreign") body.record.request.target.operation_id = crypto.randomUUID();
      return Response.json(body, { headers: { "Cache-Control": "no-store" } });
    });
    const before = [...setup.writes];
    await expect(client.observeCompleted(setup.request)).rejects.toThrow();
    expect(setup.writes).toEqual(before);
    expect(setup.sent).toHaveLength(1);
  }
});

test("setup waits only for read-only health and never prepares against an unreachable or foreign runtime", async () => {
  for (const failure of ["unreachable", "version"] as const) {
    const setup = await m6SetupFixture();
    const calls: string[] = [];
    let delays = 0;
    const client = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot }, async (url) => {
      calls.push(url.pathname);
      return failure === "unreachable" ? new Response(null, { status: 503 }) : Response.json({ result: "candidate", m6_ready: false,
        worker_version_id: crypto.randomUUID() }, { headers: { "Cache-Control": "no-store" } });
    });
    await expect(client.initialize(setup.request.target, { maximumReads: 2, delay: async () => { delays++; } })).rejects.toThrow("no preparation was sent");
    expect(calls).toEqual(["/admin/health", "/admin/health"]);
    expect(delays).toBe(1);
    expect(setup.sent).toEqual([]);
    expect(await readServiceAdmission(setup.env, setup.config.service_id)).toBeNull();
  }
});

test("foreign targets, origins, changed deployments and externally cached probes cannot complete setup", async () => {
  for (const failure of ["target", "deployment", "cache", "receipt"] as const) {
    const setup = await m6SetupFixture();
    let reads = 0;
    let cached: Response | undefined;
    const client = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => {
      const snapshot = structuredClone(setup.snapshot);
      if (failure === "deployment" && ++reads === 2) for (const observation of snapshot.deployments) observation.deployments[0]!.id = crypto.randomUUID();
      return snapshot;
    } }, async (url, init) => {
      const response = await setup.run(new Request(url, init));
      if (failure === "cache" && url.pathname.endsWith("/probe")) { cached ??= response; return cached.clone(); }
      if (failure === "receipt" && url.pathname.endsWith("/complete")) {
        const body = await response.json<{ readiness: { worker_version_id: string } }>();
        body.readiness.worker_version_id = crypto.randomUUID();
        return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      }
      return response;
    });
    await expect(client.initialize({ ...setup.request.target, ...(failure === "target" ? { service_config_sha256: "f".repeat(64) } : {}) },
      { maximumReads: 1, delay: async () => { await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env); } })).rejects.toThrow();
    expect((await readServiceAdmission(setup.env, setup.config.service_id))?.value.state).toBe(failure === "target" ? undefined : failure === "receipt" ? "paused" : "initializing");
    if (failure === "target") expect(setup.sent).toHaveLength(0);
    expect(() => new M6SetupClient({ ...setup.config, workers_dev_base_url: "https://another.example.workers.dev" }, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot })).toThrow("workers.dev");
  }
});

test("fresh setup does not adopt a custom-domain configuration even with a valid management origin", async () => {
  const setup = await m6SetupFixture({ publicBaseUrl: "https://podcasts.example.com" });
  const client = new M6SetupClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => { throw new Error("No REST observation is allowed"); } },
    async () => { throw new Error("No HTTP request is allowed"); });
  await expect(client.initialize(setup.request.target)).rejects.toThrow("matching workers.dev");
  expect(await readServiceAdmission(setup.env, setup.config.service_id)).toBeNull();
});
