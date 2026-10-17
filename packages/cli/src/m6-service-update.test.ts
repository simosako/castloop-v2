import { expect, test } from "bun:test";
import { createM6UpdateJournal, readLocalM6Update, resumeM6UpdateActivation, resumeM6UpdateCompletion, resumeM6UpdateDeploymentVerification, runM6Update } from "./m6-service-update";
import type { M6UpdateEffects } from "./m6-service-update";
import { workerPayloadHash as migrationPayloadHash } from "./worker-upload-hash";
import { beginM6ServiceUpdate, completeM6ServiceUpdate } from "../../../src/m6-service-update";
import { readServiceAdmission } from "../../../src/service-admission";
import { m6UpdateFixture } from "../../../src/test-support/m6-update";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test.each(["read", "activation"] as const)("activation checkpoints distinguish pre-POST reads from unknown writes (%s)", async (failure) => {
  const setup = await m6UpdateFixture();
  const request = { ...setup.request, worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) };
  const root = mkdtempSync("/tmp/opencode/castloop-activation-checkpoint-");
  try {
    const journal = await createM6UpdateJournal(root, setup.config, request);
    const uploaded = { id: setup.newTarget.worker_version_id, number: 2, resources: { script: { etag: "acknowledged-script" } } };
    const calls: string[] = [];
    const effects: M6UpdateEffects = {
      begin: async () => { await beginM6ServiceUpdate(setup.env, request); },
      deploy: async (_config, _request, _source, _metadata, receipts) => {
        calls.push("upload");
        receipts!.uploaded(uploaded, setup.target.deployment_id);
        expect(journal.load().activation_checkpoint?.state).toBe("not_started");
        if (failure !== "read") {
          receipts!.activating();
          expect(journal.load().activation_checkpoint?.state).toBe("requested");
          calls.push("activation");
        }
        throw new Error("Interrupted");
      },
      activate: async (_config, _request, receipt, previousDeploymentId, receipts) => {
        expect(receipt).toEqual(uploaded);
        expect(previousDeploymentId).toBe(setup.target.deployment_id);
        receipts.activating();
        calls.push("activation");
        receipts.deployed(setup.newTarget);
        return setup.newTarget;
      },
      complete: async () => completeM6ServiceUpdate(setup.newEnv, request, setup.newTarget, setup.updateChecks),
    };
    await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("Interrupted");
    const state = journal.load();
    expect(state.schema_version).toBe(2);
    await journal.exclusively(async () => {
      expect(() => journal.save({ ...state, activation_checkpoint: { ...state.activation_checkpoint!,
        previous_deployment_id: crypto.randomUUID() } })).toThrow("rewrite its activation checkpoint");
      expect(() => journal.save({ ...state, schema_version: 1, activation_checkpoint: undefined })).toThrow();
      expect(() => journal.save({ ...state, activation_checkpoint: undefined })).toThrow();
      if (failure !== "read") expect(() => journal.save({ ...state,
        activation_checkpoint: { ...state.activation_checkpoint!, state: "not_started" } })).toThrow("rewrite its activation checkpoint");
    });
    const reopened = await createM6UpdateJournal(root, setup.config, request);
    if (failure === "read") {
      await expect(resumeM6UpdateActivation(reopened, { ...effects, activate: async () => { throw new Error("GET timeout"); } })).rejects.toThrow("GET timeout");
      expect(reopened.load()).toEqual(state);
      await resumeM6UpdateActivation(reopened, effects);
      expect(reopened.load().phase).toBe("completed");
      expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
      await expect(resumeM6UpdateActivation(reopened, effects)).rejects.toThrow("cannot be replayed");
    } else {
      await expect(resumeM6UpdateActivation(reopened, effects)).rejects.toThrow("cannot be replayed");
      expect(reopened.load()).toEqual(state);
      expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("updating");
    }
    expect(calls).toEqual(["upload", "activation"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([false, true])("legacy journals never infer an unstarted activation, but keep acknowledged verification (%s)", async (hasDeployment) => {
  const setup = await m6UpdateFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-activation-legacy-");
  try {
    const journal = await createM6UpdateJournal(root, setup.config, setup.request);
    const legacy = { ...journal.load(), schema_version: 1, phase: "deploy_requested",
      upload_receipt: { id: setup.newTarget.worker_version_id, number: 2, resources: { script: { etag: "old-receipt" } } },
      ...(hasDeployment ? { deployment_receipt: setup.newTarget } : {}) };
    const path = join(root, ".castloop", "service-updates", setup.config.service_id, `${setup.request.operation_id}.json`);
    writeFileSync(path, JSON.stringify(legacy));
    const before = readFileSync(path, "utf8");
    let calls = 0;
    const effects: M6UpdateEffects = { begin: async () => { calls++; }, deploy: async () => { calls++; return setup.newTarget; },
      activate: async () => { calls++; return setup.newTarget; }, verifyDeployment: async () => { calls++; return setup.newTarget; },
      complete: async () => { calls++; return setup.newReadiness; } };
    await expect(resumeM6UpdateActivation(journal, effects)).rejects.toThrow("legacy or unknown");
    expect(calls).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    await journal.exclusively(async () => {
      expect(() => journal.save({ ...journal.load(), schema_version: 2, activation_checkpoint: {
        previous_deployment_id: setup.target.deployment_id, state: "not_started" } })).toThrow();
    });
    if (hasDeployment) {
      await resumeM6UpdateDeploymentVerification(journal, effects);
      expect(calls).toBe(2);
      expect(journal.load().phase).toBe("completed");
    } else {
      await expect(resumeM6UpdateDeploymentVerification(journal, effects)).rejects.toThrow("both durable");
      expect(calls).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
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
          if (receipt !== "none") receipts!.uploaded(uploaded, crypto.randomUUID());
          if (receipt === "both") { receipts!.activating(); receipts!.deployed(setup.newTarget); }
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
