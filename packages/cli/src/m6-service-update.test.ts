import { expect, test } from "bun:test";
import { createM6UpdateJournal, readLocalM6Update, resumeM6UpdateCompletion, resumeM6UpdateDeploymentVerification, runM6Update } from "./m6-service-update";
import type { M6UpdateEffects } from "./m6-service-update";
import { migrationPayloadHash } from "./migration-deployment";
import { beginM6ServiceUpdate, completeM6ServiceUpdate } from "../../../src/m6-service-update";
import { readServiceAdmission } from "../../../src/service-admission";
import { m6UpdateFixture } from "../../../src/test-support/m6-update";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = "simulated-compatible-worker";
const metadata = { secret: "private-administrator-secret" };

test("ordinary update journal admits, deploys once and verifies without data conversion or automatic resume", async () => {
  const setup = await m6UpdateFixture();
  const request = { ...setup.request, worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) };
  const root = mkdtempSync("/tmp/opencode/castloop-compatible-update-");
  try {
    const journal = await createM6UpdateJournal(root, setup.config, request);
    const calls: string[] = [];
    const effects = {
      begin: async () => { calls.push("begin"); expect(journal.load().phase).toBe("begin_requested"); await beginM6ServiceUpdate(setup.env, request); },
      deploy: async () => { calls.push("deploy"); expect(journal.load().phase).toBe("deploy_requested"); return setup.newTarget; },
      complete: async () => {
        calls.push("complete"); expect(journal.load().phase).toBe("completion_requested");
        return completeM6ServiceUpdate(setup.newEnv, request, setup.newTarget, setup.updateChecks);
      },
    };
    await runM6Update(journal, effects, source, metadata);
    expect(calls).toEqual(["begin", "deploy", "complete"]);
    expect(journal.load().phase).toBe("completed");
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
    const text = readFileSync(join(root, ".castloop", "service-updates", setup.config.service_id, `${request.operation_id}.json`), "utf8");
    expect(text).not.toContain(source);
    expect(text).not.toContain(metadata.secret);
    await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("without replay");
    await expect(resumeM6UpdateCompletion(journal, effects)).rejects.toThrow("acknowledged");
    expect(calls).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown ordinary update requests are retained; changed payloads, phase skips and unlocked writes are refused", async () => {
  for (const failure of ["begin", "deploy", "complete"] as const) {
    const setup = await m6UpdateFixture();
    const request = { ...setup.request, worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) };
    const root = mkdtempSync("/tmp/opencode/castloop-compatible-unknown-");
    try {
      const journal = await createM6UpdateJournal(root, setup.config, request);
      let calls = 0;
      const call = (phase: string) => { calls += 1; if (phase === failure) throw new Error("Response lost"); };
      const effects = { begin: async () => { call("begin"); }, deploy: async () => { call("deploy"); return setup.newTarget; },
        complete: async () => { call("complete"); return setup.newReadiness; } };
      await expect(runM6Update(journal, effects, `${source}-changed`, metadata)).rejects.toThrow("differs");
      expect(calls).toBe(0);
      expect(() => journal.save({ ...journal.load(), phase: "begin_requested" })).toThrow("exclusive client lock");
      await journal.exclusively(async () => { expect(() => journal.save({ ...journal.load(), phase: "deploy_requested" })).toThrow("skip phases"); });
      await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("Response lost");
      expect(journal.load().phase).toBe(failure === "begin" ? "begin_requested" : failure === "deploy" ? "deploy_requested" : "completion_requested");
      const before = calls;
      await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("without replay");
      await expect(resumeM6UpdateCompletion(journal, effects)).rejects.toThrow("without replay");
      expect(calls).toBe(before);
      await expect(createM6UpdateJournal(root, setup.config, { ...request, worker_source_sha256: "c".repeat(64) })).rejects.toThrow("another frozen request");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("durable upload/deployment receipts permit explicit verification only, never a second deployment", async () => {
  for (const receipt of ["none", "upload-only", "both"] as const) {
    const setup = await m6UpdateFixture();
    const request = { ...setup.request, worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) };
    const root = mkdtempSync("/tmp/opencode/castloop-compatible-receipts-");
    try {
      const journal = await createM6UpdateJournal(root, setup.config, request);
      const uploaded = { id: setup.newTarget.worker_version_id, number: 2, resources: { script: { etag: "acknowledged-script" } } };
      const calls: string[] = [];
      const effects: M6UpdateEffects = { begin: async () => { await beginM6ServiceUpdate(setup.env, request); },
        deploy: async (_config, _request, _source, _metadata, receipts) => {
          calls.push("deploy");
          if (receipt !== "none") receipts!.uploaded(uploaded);
          if (receipt === "both") receipts!.deployed(setup.newTarget);
          throw new Error("Verification interrupted after acknowledged writes");
        },
        verifyDeployment: async (_config, _request, upload, deployment) => {
          calls.push("verify"); expect(upload).toEqual(uploaded); expect(deployment).toEqual(setup.newTarget); return deployment;
        },
        complete: async () => completeM6ServiceUpdate(setup.newEnv, request, setup.newTarget, setup.updateChecks) };
      await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("interrupted");
      expect(readLocalM6Update(root, setup.config, request.operation_id).state).toEqual(journal.load());
      expect(journal.load().phase).toBe("deploy_requested");
      if (receipt === "both") {
        await journal.exclusively(async () => {
          expect(() => journal.save({ ...journal.load(), upload_receipt: { ...uploaded, number: 3 } })).toThrow("rewrite receipts");
        });
        await expect(resumeM6UpdateDeploymentVerification(journal, { ...effects,
          verifyDeployment: async () => { throw new Error("Readonly verification rejected"); } })).rejects.toThrow("rejected");
        expect(journal.load().phase).toBe("deploy_requested");
        await resumeM6UpdateDeploymentVerification(journal, effects);
        expect(journal.load().phase).toBe("completed");
        expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
        expect(calls).toEqual(["deploy", "verify"]);
      } else {
        await expect(resumeM6UpdateDeploymentVerification(journal, effects)).rejects.toThrow("both durable");
        expect(calls).toEqual(["deploy"]);
      }
      await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("without replay");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
