import { expect, test } from "bun:test";
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
  expect(calls).toEqual(["rest", "POST /admin/setup/prepare", "POST /admin/setup/status", "GET /admin/setup/probe", "GET /admin/setup/probe", "rest", "POST /admin/setup/complete"]);
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
    expect(() => new M6SetupClient({ ...setup.config, public_base_url: "https://another.example.workers.dev" }, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot })).toThrow("matching workers.dev");
  }
});
