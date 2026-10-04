import { expect, test } from "bun:test";
import { domainAdminResponseSchema, domainOperationRequestSchema, m6ServiceConfigHash, serviceManagementBaseUrl, stringifyToml } from "../packages/shared/src/index";
import { fetchM6Candidate, fetchM6ManagementIntegration } from "./m6-routes";
import { pauseServiceAdmission, readServiceAdmission, resumeServiceAdmission } from "./service-admission";
import { lifecycleAdminFixture } from "./test-support/lifecycle-admin";

async function fixture() {
  const setup = await lifecycleAdminFixture();
  const env = setup.candidateEnv;
  const config = { ...setup.config, public_base_url: serviceManagementBaseUrl(setup.config) };
  await setup.bucket.put("system/service.toml", stringifyToml(config));
  const pauseId = crypto.randomUUID();
  await pauseServiceAdmission(env, "service", pauseId, setup.versionId);
  const admission = (await readServiceAdmission(env, "service"))!.value;
  const management = serviceManagementBaseUrl(config);
  const request = domainOperationRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: "service", pause_id: pauseId,
    expected_service_generation: admission.generation, worker_version_id: setup.versionId,
    service_config_sha256: await m6ServiceConfigHash(config), workers_dev_base_url: management,
    public_base_url: "https://podcasts.example.com", domain_change: { action: "add", hostname: "podcasts.example.com" },
    target_service_config_sha256: await m6ServiceConfigHash({ ...config, public_base_url: "https://podcasts.example.com", workers_dev_base_url: management }) });
  const call = (input: unknown, key = "private-secret", method = "POST") => fetchM6ManagementIntegration(new Request(`${management}/admin/domain`, {
    method, headers: { "X-Castloop-Key": key }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  }), env, setup.cachedAssets);
  const success = async (input: unknown) => {
    const response = await call(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return domainAdminResponseSchema.parse(await response.json());
  };
  return { ...setup, config, env, request, pauseId, management, call, success };
}

test("domain route authenticates bounded strict inputs and remains absent from migration-only candidates", async () => {
  const setup = await fixture();
  const input = { action: "inspect", service_id: "service" };
  expect((await setup.call(input, "wrong")).status).toBe(401);
  expect((await setup.call(input, "private-secret", "GET")).status).toBe(405);
  for (const bad of [{ ...input, extra: true }, { ...input, service_id: "foreign" }, "x".repeat(16385)]) {
    expect([400, 409]).toContain((await setup.call(bad)).status);
  }
  const before = [...setup.entries];
  await setup.success(input);
  expect([...setup.entries]).toEqual(before);
  const request = new Request(`${setup.management}/admin/domain`, { method: "POST", headers: { "X-Castloop-Key": "private-secret" }, body: JSON.stringify(input) });
  expect((await fetchM6Candidate(request, setup.env, setup.cachedAssets)).status).toBe(409);
});

test("connection tokens serialize external IO and only their matching durable receipt releases them", async () => {
  const setup = await fixture();
  const request = setup.request;
  await setup.success({ action: "begin", request });
  expect((await setup.call({ action: "step", request })).status).toBe(409);
  const token = crypto.randomUUID();
  await setup.success({ action: "claim-connection", request, execution_id: token });
  const status = await setup.success({ action: "status", request });
  expect(status.admission.url_change?.execution_id).toBe(token);
  expect(status.admission.url_change?.execution_kind).toBe("connection");
  for (const action of ["step", "complete"]) expect((await setup.call({ action, request })).status).toBe(409);
  expect((await setup.call({ action: "claim-connection", request, execution_id: token })).status).toBe(409);
  await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId, setup.versionId)).rejects.toThrow();
  const receipt = { action: "add", execution_id: token, domain_id: "owned-domain" };
  expect((await setup.call({ action: "return-connection", request, receipt: { ...receipt, execution_id: crypto.randomUUID() } })).status).toBe(409);
  await setup.success({ action: "return-connection", request, receipt });
  await setup.success({ action: "return-connection", request, receipt });
  expect((await setup.call({ action: "claim-connection", request, execution_id: crypto.randomUUID() })).status).toBe(409);
  for (let step = 0; step < 10; step++) {
    if ((await setup.success({ action: "step", request })).progress?.phase === "configured") break;
  }
  const complete = await setup.success({ action: "complete", request });
  expect(complete.progress?.phase).toBe("complete");
  expect(complete.admission.url_change).toBeUndefined();
  expect(complete.admission.state).toBe("paused");
});

test("unauthenticated nonce probes verify runtime without exposing or reopening paused content", async () => {
  const setup = await fixture();
  await setup.success({ action: "begin", request: setup.request });
  const nonce = crypto.randomUUID();
  const response = await fetchM6ManagementIntegration(new Request(`https://podcasts.example.com/.well-known/castloop/runtime?nonce=${nonce}`), setup.env, setup.cachedAssets);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json<unknown>()).toEqual({ schema_version: 1, service_id: "service", worker_name: setup.config.worker_name,
    worker_version_id: setup.versionId, nonce });
  for (const path of ["/podcasts/daily/feed.xml", "/system/service.toml", "/staging/shows/daily/secret"]) {
    expect((await fetchM6ManagementIntegration(new Request(`https://podcasts.example.com${path}`), setup.env, setup.cachedAssets)).status).toBe(path.startsWith("/podcasts/") ? 503 : 404);
  }
  expect((await fetchM6ManagementIntegration(new Request(`${setup.management}/.well-known/castloop/runtime?nonce=bad`), setup.env, setup.cachedAssets)).status).toBe(503);
});
