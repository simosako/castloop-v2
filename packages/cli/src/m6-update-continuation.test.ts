import { expect, test } from "bun:test";
import { buildM6WorkerUploadMetadata, serviceAdmissionSchema } from "@castloop/shared";
import type { M6RuntimeTarget, M6ServiceUpdateRequest } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { runM6Command } from "./m6-commands";
import { createM6UpdateJournal, resumeM6UpdateActivation, runM6Update } from "./m6-service-update";
import { M6UpdateClient } from "./m6-update-client";
import { createM6UpdateRestEffects } from "./m6-update-rest";
import { workerPayloadHash } from "./worker-upload-hash";
import { beginM6ServiceUpdate, completeM6ServiceUpdate } from "../../../src/m6-service-update";
import { readServiceAdmission } from "../../../src/service-admission";
import { m6UpdateFixture } from "../../../src/test-support/m6-update";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test.each(["success", "settings", "deployment", "history", "content", "owner", "owner-after-reads", "lock", "activation-unknown",
  "checkpoint-save", "checkpoint-after-save", "receipt-save", "post-activation-read"] as const)(
  "formal update continuation reuses the exact upload and refuses drift or unknown writes (%s)", async (scenario) => {
    const setup = await m6UpdateFixture();
    const root = mkdtempSync("/tmp/opencode/castloop-update-continuation-");
    const originalFetch = globalThis.fetch;
    const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const originalToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = setup.config.account_id;
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    let uploaded = false;
    let deployed = false;
    let resuming = false;
    let allowVerification = false;
    let ownerReads = 0;
    const writes: string[] = [];
    const reads: string[] = [];
    const oldMetadata = buildM6WorkerUploadMetadata(setup.config, null, "private-secret");
    oldMetadata.bindings.push({ name: "EXTRA_SECRET", type: "secret_text" });
    const reply = (result: unknown) => Response.json({ success: true, result, result_info: { total_pages: 1 } });
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const http = new Request(input, init);
      const url = new URL(http.url);
      expect(url.origin).toBe("https://api.cloudflare.com");
      expect(http.headers.get("Authorization")).toBe("Bearer test-token");
      if (http.method !== "GET") writes.push(url.pathname);
      else reads.push(url.pathname);
      if (url.pathname.endsWith("/versions")) {
        if (http.method === "POST") {
          expect(uploaded).toBe(false);
          uploaded = true;
          return reply({ id: setup.newTarget.worker_version_id, number: 2, resources: { script: { etag: "uploaded-script" } } });
        }
        return reply({ items: uploaded ? [{ id: setup.newTarget.worker_version_id, number: 2 },
          { id: setup.versionId, number: resuming && scenario === "history" ? 0 : 1 }] : [{ id: setup.versionId, number: 1 }] });
      }
      if (url.pathname.endsWith("/settings")) {
        if (uploaded && !resuming && scenario !== "activation-unknown") throw new Error("Settings GET timeout");
        if (deployed && scenario === "post-activation-read" && !allowVerification) throw new Error("Verification GET timeout");
        return reply(resuming && scenario === "settings" ? { ...oldMetadata, tags: ["foreign-tag"] } : oldMetadata);
      }
      if (url.pathname.endsWith("/deployments")) {
        if (http.method === "POST") {
          const state = JSON.parse(readFileSync(join(root, ".castloop", "service-updates", setup.config.service_id,
            `${setup.request.operation_id}.json`), "utf8"));
          expect(state.activation_checkpoint.state).toBe("requested");
          expect(await http.json<unknown>()).toEqual({ strategy: "percentage", versions: [{ version_id: setup.newTarget.worker_version_id, percentage: 100 }] });
          deployed = true;
          if (scenario === "activation-unknown") throw new Error("Activation POST response lost");
          return reply({ id: setup.newTarget.deployment_id });
        }
        return reply({ deployments: [{ id: deployed ? setup.newTarget.deployment_id :
          resuming && scenario === "deployment" ? crypto.randomUUID() : setup.target.deployment_id, strategy: "percentage",
          versions: [{ version_id: deployed ? setup.newTarget.worker_version_id : setup.versionId, percentage: 100 }] }] });
      }
      if (url.pathname.includes("/versions/")) {
        const id = url.pathname.split("/").at(-1)!;
        return reply({ id, resources: { bindings: oldMetadata.bindings,
          script: { etag: resuming && scenario === "content" ? "foreign-script" : "uploaded-script",
            handlers: ["fetch", "queue"], named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
          script_runtime: { compatibility_date: oldMetadata.compatibility_date, compatibility_flags: oldMetadata.compatibility_flags,
            exports: oldMetadata.exports } } });
      }
      if (url.pathname.endsWith("/subdomain")) return reply({ enabled: true, previews_enabled: false });
      if (url.pathname.endsWith("/workers/domains")) return reply([{ id: "domain-id", hostname: new URL(setup.config.public_base_url).hostname,
        service: setup.config.worker_name, zone_id: "z".repeat(32), zone_name: "example.com" }]);
      throw new Error("Unexpected request");
    }, { preconnect: originalFetch.preconnect });
    try {
      const api = new CloudflareApi(setup.config);
      const metadata = await api.prepareCompatibleM6WorkerUpload(setup.config, setup.versionId);
      const request = { ...setup.request, worker_source_sha256: workerPayloadHash("worker-source"), worker_metadata_sha256: workerPayloadHash(metadata) };
      const journal = await createM6UpdateJournal(root, setup.config, request);
      writeFileSync(join(root, ".castloop", "secrets.json"), JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" }), { mode: 0o600 });
      const admission = async () => {
        const value = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
        if (resuming) ownerReads++;
        return resuming && (scenario === "owner" || scenario === "owner-after-reads" && ownerReads > 1) ?
          serviceAdmissionSchema.parse({ ...value, generation: value.generation + 1 }) : value;
      };
      const complete = (input: M6ServiceUpdateRequest, target: M6RuntimeTarget) => completeM6ServiceUpdate(setup.newEnv, input, target, setup.updateChecks);
      const effects = createM6UpdateRestEffects(api, { begin: (input) => beginM6ServiceUpdate(setup.env, input), admission, complete });
      await expect(runM6Update(journal, effects, "worker-source", metadata)).rejects.toThrow();
      expect(journal.load().upload_receipt?.id).toBe(setup.newTarget.worker_version_id);
      expect(journal.load().activation_checkpoint?.state).toBe(scenario === "activation-unknown" ? "requested" : "not_started");
      expect(writes.filter((path) => path.endsWith("/versions"))).toHaveLength(1);
      expect((await admission()).state).toBe("updating");
      const before = journal.load();
      const beforeReads = reads.length;
      resuming = true;
      if (scenario === "lock") writeFileSync(join(root, ".castloop", "service-updates", setup.config.service_id, `${request.operation_id}.json.lock`), "unknown-owner");
      class ContinuationClient extends M6UpdateClient {
        override admission = admission;
        override complete = complete;
      }
      const command = (name = "update-service-continue") => runM6Command(root, setup.config, name, [request.operation_id], {
        workerSource: async () => { throw new Error("Continuation must not rebuild or upload source"); },
        updateClient: (cloudflare, key) => new ContinuationClient(setup.config, key, cloudflare),
      });
      if (scenario === "checkpoint-save" || scenario === "checkpoint-after-save" || scenario === "receipt-save") {
        const failedJournal = { ...journal, save: (state: Parameters<typeof journal.save>[0]) => {
          if (scenario === "checkpoint-save" && state.activation_checkpoint?.state === "requested" ||
            scenario === "receipt-save" && state.deployment_receipt) throw new Error("Journal fsync failed");
          journal.save(state);
          if (scenario === "checkpoint-after-save" && state.activation_checkpoint?.state === "requested") throw new Error("Journal fsync failed");
        } };
        await expect(resumeM6UpdateActivation(failedJournal, effects)).rejects.toThrow("Journal fsync failed");
        expect(journal.load().activation_checkpoint?.state).toBe(scenario === "checkpoint-save" ? "not_started" : "requested");
        if (scenario !== "checkpoint-save") await expect(command()).rejects.toThrow("cannot be replayed");
      } else if (scenario === "success") {
        expect(await command()).toMatchObject({ result: "updated-paused", operation_id: request.operation_id });
        expect(journal.load().phase).toBe("completed");
        expect((await admission()).state).toBe("paused");
        await expect(command()).rejects.toThrow("cannot be replayed");
      } else {
        await expect(command()).rejects.toThrow();
        expect(journal.load().phase).toBe("deploy_requested");
        expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("updating");
        if (scenario === "post-activation-read") {
          expect(journal.load().activation_checkpoint?.state).toBe("requested");
          expect(journal.load().deployment_receipt).toEqual(setup.newTarget);
          await expect(command()).rejects.toThrow("cannot be replayed");
          allowVerification = true;
          expect(await command("update-service-verify")).toMatchObject({ result: "updated-paused", operation_id: request.operation_id });
          expect(journal.load().phase).toBe("completed");
          expect((await admission()).state).toBe("paused");
        } else expect(journal.load()).toEqual(before);
        if (scenario === "lock" || scenario === "activation-unknown" || scenario === "owner") expect(reads).toHaveLength(beforeReads);
      }
      expect(writes.filter((path) => path.endsWith("/versions"))).toHaveLength(1);
      expect(writes.filter((path) => path.endsWith("/deployments"))).toHaveLength(
        ["success", "activation-unknown", "receipt-save", "post-activation-read"].includes(scenario) ? 1 : 0);
      const text = readFileSync(join(root, ".castloop", "service-updates", setup.config.service_id, `${request.operation_id}.json`), "utf8");
      expect(text).not.toContain("private-secret");
      expect(text).not.toContain("worker-source");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
      if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = originalToken;
      rmSync(root, { recursive: true, force: true });
    }
  });

test.each(["legacy", "requested", "lock"] as const)("public CLI rejects unsafe continuation before any HTTP request (%s)", async (scenario) => {
  const setup = await m6UpdateFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-update-cli-refusal-");
  try {
    const journal = await createM6UpdateJournal(root, setup.config, setup.request);
    const path = join(root, ".castloop", "service-updates", setup.config.service_id, `${setup.request.operation_id}.json`);
    const state = { ...journal.load(), schema_version: scenario === "legacy" ? 1 : 2, phase: "deploy_requested",
      upload_receipt: { id: setup.newTarget.worker_version_id, number: 2, resources: { script: { etag: "uploaded-script" } } },
      ...(scenario === "legacy" ? {} : { activation_checkpoint: { previous_deployment_id: setup.target.deployment_id,
        state: scenario === "requested" ? "requested" : "not_started" } }) };
    writeFileSync(path, JSON.stringify(state));
    if (scenario === "lock") writeFileSync(`${path}.lock`, "unknown-owner");
    const before = readFileSync(path, "utf8");
    writeFileSync(join(root, "castloop.toml"), setup.text("system/service.toml")!);
    writeFileSync(join(root, ".castloop", "secrets.json"), JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" }));
    const preload = join(root, "no-network.ts");
    writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("Unexpected HTTP request"); };\n');
    const result = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"),
      "update-service-continue", setup.request.operation_id], { cwd: root,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: setup.config.account_id, CLOUDFLARE_API_TOKEN: "test-token" } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(scenario === "lock" ? "unknown lock" : "cannot be replayed");
    expect(result.stderr.toString()).not.toContain("Unexpected HTTP");
    expect(readFileSync(path, "utf8")).toBe(before);
    if (scenario === "lock") expect(readFileSync(`${path}.lock`, "utf8")).toBe("unknown-owner");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
