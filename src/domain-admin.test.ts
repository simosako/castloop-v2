import { expect, spyOn, test } from "bun:test";
import { cachedDeliveryRuntimeSchema, domainAdminResponseSchema, serviceAdmissionSchema, stringifyToml } from "../packages/shared/src/index";
import { fetchM6Candidate, fetchM6ManagementIntegration } from "./m6-routes";
import { resumeServiceAdmission } from "./service-admission";
import { domainAdminFixture } from "./test-support/domain-admin";

async function fixture() {
  const setup = await domainAdminFixture();
  const { env, management } = setup;
  const call = (input: unknown, key = "private-secret", method = "POST") => fetchM6ManagementIntegration(new Request(`${management}/admin/domain`, {
    method, headers: { "X-Castloop-Key": key }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  }), env, setup.cachedAssets);
  const success = async (input: unknown) => {
    const response = await call(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return domainAdminResponseSchema.parse(await response.json());
  };
  return { ...setup, call, success };
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

test("runtime probes read configuration and admission only once per request without writing or caching readiness", async () => {
  const setup = await fixture();
  const before = [...setup.entries];
  const get = spyOn(setup.bucket, "get");
  const head = spyOn(setup.bucket, "head");
  const describe = spyOn(setup.cachedAssets, "describeRuntime");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      get.mockClear();
      const nonce = crypto.randomUUID();
      const response = await fetchM6ManagementIntegration(new Request(`https://podcasts.example.com/.well-known/castloop/runtime?nonce=${nonce}`),
        setup.env, setup.cachedAssets);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json<unknown>()).toEqual({ schema_version: 1, service_id: setup.config.service_id,
        worker_name: setup.config.worker_name, worker_version_id: setup.versionId, nonce });
      expect(get.mock.calls.map(([key]) => key)).toEqual(["system/service.toml", "system/lifecycle-service.json"]);
    }
    expect(head).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledTimes(2);
    expect([...setup.entries]).toEqual(before);
  } finally { get.mockRestore(); head.mockRestore(); describe.mockRestore(); }
});

test("runtime probes reject invalid methods and nonces before storage or cache-owner IO", async () => {
  const setup = await fixture();
  const get = spyOn(setup.bucket, "get");
  const head = spyOn(setup.bucket, "head");
  const describe = spyOn(setup.cachedAssets, "describeRuntime");
  try {
    for (const [method, query, status] of [["GET", "", 503], ["GET", "?nonce=bad", 503],
      ["POST", `?nonce=${crypto.randomUUID()}`, 405], ["HEAD", `?nonce=${crypto.randomUUID()}`, 405]] as const) {
      const response = await fetchM6ManagementIntegration(new Request(`https://podcasts.example.com/.well-known/castloop/runtime${query}`, { method }),
        setup.env, setup.cachedAssets);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  } finally { get.mockRestore(); head.mockRestore(); describe.mockRestore(); }
});

test("runtime probes observe changed configuration, admission and runtime instead of reusing previous success", async () => {
  const setup = await fixture();
  const probe = () => fetchM6ManagementIntegration(new Request(`https://podcasts.example.com/.well-known/castloop/runtime?nonce=${crypto.randomUUID()}`),
    setup.env, setup.cachedAssets);
  const before = [...setup.entries];
  const configuration = setup.entries.get("system/service.toml")!;
  const admission = setup.entries.get("system/lifecycle-service.json")!;
  const value = serviceAdmissionSchema.parse(JSON.parse(new TextDecoder().decode(admission.bytes)));
  const unavailable = async () => {
    const response = await probe();
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json<unknown>()).toEqual({ reason_code: "domain_probe_unavailable" });
  };
  expect((await probe()).status).toBe(200);
  setup.entries.delete("system/service.toml");
  await unavailable();
  await setup.bucket.put("system/service.toml", stringifyToml({ ...setup.config, service_id: "foreign" }));
  await unavailable();
  setup.entries.set("system/service.toml", configuration);
  setup.entries.delete("system/lifecycle-service.json");
  await unavailable();
  await setup.bucket.put("system/lifecycle-service.json", JSON.stringify({ ...value,
    runtime_readiness: { ...value.runtime_readiness, worker_version_id: crypto.randomUUID() } }));
  await unavailable();
  await setup.bucket.put("system/lifecycle-service.json", JSON.stringify({ ...value, mode: "legacy",
    runtime_readiness: undefined, readiness: undefined }));
  await unavailable();
  await setup.bucket.put("system/lifecycle-service.json", JSON.stringify(serviceAdmissionSchema.parse({ ...value, state: "updating",
    update: { request: { operation_id: crypto.randomUUID(), service_id: "service", expected_service_generation: value.generation,
      pause_id: setup.pauseId, previous_worker_version_id: setup.versionId, service_config_sha256: setup.request.service_config_sha256,
      worker_source_sha256: "0".repeat(64), worker_metadata_sha256: "0".repeat(64) } } })));
  await unavailable();
  setup.entries.set("system/lifecycle-service.json", admission);
  setup.env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
  await unavailable();
  setup.env.CASTLOOP_VERSION_METADATA.id = setup.versionId;
  const runtime = cachedDeliveryRuntimeSchema.parse(await setup.cachedAssets.describeRuntime());
  const describe = spyOn(setup.cachedAssets, "describeRuntime");
  try {
    describe.mockResolvedValueOnce({ ...runtime, worker_version_id: crypto.randomUUID() });
    await unavailable();
    describe.mockRejectedValueOnce(new Error("Cache owner unavailable"));
    await unavailable();
    expect((await probe()).status).toBe(200);
    expect(setup.entries).toEqual(new Map(before));
  } finally { describe.mockRestore(); }
});
