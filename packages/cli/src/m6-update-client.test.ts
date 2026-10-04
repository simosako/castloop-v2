import { expect, test } from "bun:test";
import { m6ServiceUpdateRequestSchema } from "@castloop/shared";
import { M6UpdateClient } from "./m6-update-client";
import { createM6UpdateJournal, reconcileM6UpdateCompletion, runM6Update } from "./m6-service-update";
import { workerPayloadHash } from "./worker-upload-hash";
import { dropSetupCompletion } from "./test-support/drop-setup-completion";
import { consumeM6SetupProbe } from "../../../src/m6-setup-queue";
import { readServiceAdmission } from "../../../src/service-admission";
import { m6SetupFixture } from "../../../src/test-support/m6-setup";
import { mkdtempSync, rmSync } from "node:fs";

async function fixture(customDomain = false) {
  const setup = await m6SetupFixture(customDomain ? { publicBaseUrl: "https://podcasts.example.com" } : {});
  await setup.run(setup.post("prepare", setup.request));
  await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
  expect((await setup.run(setup.post("complete", { ...setup.request, snapshots: [setup.snapshot, setup.snapshot] }))).status).toBe(200);
  const source = "compatible-worker-source";
  const metadata = { frozen: "metadata" };
  const request = m6ServiceUpdateRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: setup.config.service_id,
    pause_id: setup.request.target.operation_id, expected_service_generation: (await readServiceAdmission(setup.env, setup.config.service_id))!.value.generation,
    previous_worker_version_id: setup.versionId, service_config_sha256: setup.request.target.service_config_sha256,
    worker_source_sha256: workerPayloadHash(source), worker_metadata_sha256: workerPayloadHash(metadata) });
  const target = { ...setup.request.target, operation_id: request.operation_id, deployment_id: crypto.randomUUID(), worker_version_id: crypto.randomUUID() };
  const snapshot = structuredClone(setup.snapshot);
  snapshot.version.id = target.worker_version_id;
  for (const item of snapshot.deployments) {
    item.deployments[0]!.id = target.deployment_id;
    item.deployments[0]!.versions[0]!.version_id = target.worker_version_id;
  }
  const paths: string[] = [];
  const transport = (url: URL, init: RequestInit) => {
    expect(url.origin).toBe(setup.config.workers_dev_base_url!);
    paths.push(url.pathname); return setup.run(new Request(url, init));
  };
  const client = new M6UpdateClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => snapshot }, transport);
  const deployed = () => { setup.env.CASTLOOP_VERSION_METADATA.id = target.worker_version_id; };
  const wait = { maximumReads: 1, delay: async () => { await consumeM6SetupProbe(setup.batch(setup.sent.at(-1)), setup.env); } };
  return { ...setup, source, metadata, update: request, target, updatedSnapshot: snapshot, client, paths, transport, deployed, wait };
}

test.each([false, true])("compatible update reuses authenticated CAS/HTTP/Queue checks without changing payloads (custom domain: %s)", async (customDomain) => {
  const setup = await fixture(customDomain);
  const root = mkdtempSync("/tmp/opencode/castloop-update-http-");
  try {
    await setup.bucket.put("public/unchanged.mp3", "immutable payload");
    const before = setup.text("public/unchanged.mp3");
    const journal = await createM6UpdateJournal(root, setup.config, setup.update);
    await runM6Update(journal, { begin: (request) => setup.client.begin(request), deploy: async () => {
      expect((await setup.client.admission()).state).toBe("updating");
      setup.deployed(); return setup.target;
    }, complete: (request, target) => setup.client.complete(request, target, setup.wait) }, setup.source, setup.metadata);
    expect(journal.load().phase).toBe("completed");
    expect(journal.load().runtime_readiness?.worker_version_id).toBe(setup.target.worker_version_id);
    expect((await setup.client.admission()).state).toBe("paused");
    expect(setup.text("public/unchanged.mp3")).toBe(before);
    expect(setup.paths.filter((path) => path === "/admin/update/begin")).toHaveLength(1);
    expect(setup.paths.filter((path) => path === "/admin/setup/prepare")).toHaveLength(1);
    expect(setup.sent).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a lost update completion is reconciled from its permanent request/runtime receipt without replaying any writes", async () => {
  const setup = await fixture();
  const root = mkdtempSync("/tmp/opencode/castloop-update-http-reconcile-");
  try {
    const journal = await createM6UpdateJournal(root, setup.config, setup.update);
    const client = new M6UpdateClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => setup.updatedSnapshot }, dropSetupCompletion(setup.transport));
    await expect(runM6Update(journal, { begin: (request) => client.begin(request), deploy: async () => { setup.deployed(); return setup.target; },
      complete: (request, target) => client.complete(request, target, setup.wait) }, setup.source, setup.metadata)).rejects.toThrow("outcome is unknown");
    expect(journal.load().phase).toBe("completion_requested");
    const before = [...setup.writes];
    const sent = setup.sent.length;
    await reconcileM6UpdateCompletion(journal, (request, target) => setup.client.observeCompleted(request, target));
    expect(journal.load().phase).toBe("completed");
    expect(setup.writes).toEqual(before);
    expect(setup.sent).toHaveLength(sent);
    expect((await setup.client.admission()).state).toBe("paused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compatible update rejects foreign/extra inputs and cannot turn a lost begin response into an automatic redeploy", async () => {
  const setup = await fixture();
  const malformed = new Request(`${setup.config.public_base_url}/admin/update/begin`, { method: "POST", headers: {
    "X-Castloop-Key": "private-secret" }, body: JSON.stringify({ request: setup.update, ready: true }) });
  expect((await setup.run(new Request(malformed.url, { method: "POST" }))).status).toBe(401);
  expect((await setup.run(new Request(malformed.url, { headers: { "X-Castloop-Key": "private-secret" } }))).status).toBe(405);
  expect((await setup.run(malformed)).status).toBe(400);
  await expect(setup.client.begin({ ...setup.update, service_id: "another" })).rejects.toThrow("another service");
  const root = mkdtempSync("/tmp/opencode/castloop-update-http-unknown-");
  try {
    const journal = await createM6UpdateJournal(root, setup.config, setup.update);
    const lost = new M6UpdateClient(setup.config, "private-secret", { collectM6DeploymentSnapshot: async () => setup.snapshot }, async (url, init) => {
      const response = await setup.transport(url, init); await response.body?.cancel(); throw new Error("Response lost");
    });
    let uploads = 0;
    const effects = { begin: (request: typeof setup.update) => lost.begin(request), deploy: async () => { uploads++; return setup.target; },
      complete: () => Promise.resolve(setup.readiness) };
    await expect(runM6Update(journal, effects, setup.source, setup.metadata)).rejects.toThrow("outcome is unknown");
    await expect(runM6Update(journal, effects, setup.source, setup.metadata)).rejects.toThrow("without replay");
    expect(journal.load().phase).toBe("begin_requested");
    expect(uploads).toBe(0);
    expect((await setup.client.admission()).state).toBe("updating");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
