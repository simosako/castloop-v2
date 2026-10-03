import { expect, test } from "bun:test";
import { createFreshM6InitializationJournal, readLocalFreshM6Initialization, resumeFreshM6Initialization, runFreshM6Initialization } from "./m6-service-initialization";
import { completeM6ServiceInitialization, prepareM6ServiceInitialization } from "../../../src/m6-service-initialization";
import { readServiceAdmission } from "../../../src/service-admission";
import { m6InitializationFixture } from "../../../src/test-support/m6-initialization";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = "simulated-worker-source";
const metadata = { secret: "private-administrator-secret" };

test("fresh initialization journal drives only acknowledged steps, retains no secret and does not resume admission", async () => {
  const setup = await m6InitializationFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-fresh-init-");
  const calls: string[] = [];
  try {
    expect(readLocalFreshM6Initialization(root, setup.config)).toEqual({ state: null, lockPresent: false });
    expect(existsSync(join(root, ".castloop"))).toBe(false);
    const journal = await createFreshM6InitializationJournal(root, setup.config, setup.target.operation_id, source, metadata);
    const effects = {
      createResources: async () => { calls.push("resources"); expect(journal.load().phase).toBe("resources_requested"); },
      deploy: async () => { calls.push("deploy"); expect(journal.load().phase).toBe("deploy_requested"); return setup.target; },
      initialize: async () => {
        calls.push("initialize");
        expect(journal.load().phase).toBe("initialization_requested");
        await prepareM6ServiceInitialization(setup.env, setup.target);
        return completeM6ServiceInitialization(setup.env, setup.target, setup.checks);
      },
    };
    await runFreshM6Initialization(journal, effects, source, metadata);
    expect(calls).toEqual(["resources", "deploy", "initialize"]);
    expect(journal.load().phase).toBe("initialized");
    expect(readLocalFreshM6Initialization(root, setup.config)).toEqual({ state: journal.load(), lockPresent: false });
    expect(() => readLocalFreshM6Initialization(root, { ...setup.config, worker_name: "another-worker" })).toThrow("another service configuration");
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("paused");
    const text = readFileSync(join(root, ".castloop", "service-initializations", `${setup.config.service_id}.json`), "utf8");
    expect(text).not.toContain(metadata.secret);
    expect(text).not.toContain(source);
    await expect(runFreshM6Initialization(journal, effects, source, metadata)).rejects.toThrow("without replay");
    await expect(resumeFreshM6Initialization(journal, effects)).rejects.toThrow("acknowledged deploy");
    expect(calls).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lost resource/deploy/initialization responses retain requested phases without automatic replay", async () => {
  for (const failed of ["resources", "deploy", "initialize"] as const) {
    const setup = await m6InitializationFixture();
    const root = mkdtempSync("/tmp/opencode/castloop-fresh-init-unknown-");
    try {
      const journal = await createFreshM6InitializationJournal(root, setup.config, setup.target.operation_id, source, metadata);
      const calls: string[] = [];
      const call = (stage: string) => { calls.push(stage); if (stage === failed) throw new Error("Response lost"); };
      const effects = { createResources: async () => { call("resources"); }, deploy: async () => { call("deploy"); return setup.target; },
        initialize: async () => { call("initialize"); return setup.readiness; } };
      await expect(runFreshM6Initialization(journal, effects, source, metadata)).rejects.toThrow("Response lost");
      expect(journal.load().phase).toBe(failed === "resources" ? "resources_requested" : failed === "deploy" ? "deploy_requested" : "initialization_requested");
      const before = [...calls];
      await expect(runFreshM6Initialization(journal, effects, source, metadata)).rejects.toThrow("without replay");
      await expect(resumeFreshM6Initialization(journal, effects)).rejects.toThrow("unknown request");
      expect(calls).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("source/metadata changes and a different operation identity cannot change a frozen fresh initialization", async () => {
  const setup = await m6InitializationFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-fresh-init-frozen-");
  try {
    const journal = await createFreshM6InitializationJournal(root, setup.config, setup.target.operation_id, source, metadata);
    const unused = { createResources: async () => { throw new Error("Must not start"); }, deploy: async () => setup.target,
      initialize: async () => setup.readiness };
    await expect(runFreshM6Initialization(journal, unused, `${source}-changed`, metadata)).rejects.toThrow("differs");
    await expect(runFreshM6Initialization(journal, unused, source, {})).rejects.toThrow("differs");
    await expect(createFreshM6InitializationJournal(root, setup.config, crypto.randomUUID(), source, metadata)).rejects.toThrow("different frozen");
    expect(journal.load().phase).toBe("prepared");
    expect(() => journal.save({ ...journal.load(), phase: "resources_requested" })).toThrow("exclusive client lock");
    await journal.exclusively(async () => {
      expect(() => journal.save({ ...journal.load(), phase: "deploy_requested" })).toThrow("skip phases");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh initialization keeps its lock throughout live IO and resumes only an acknowledged deployment", async () => {
  const setup = await m6InitializationFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-fresh-init-lock-");
  try {
    const journal = await createFreshM6InitializationJournal(root, setup.config, setup.target.operation_id, source, metadata);
    const other = await createFreshM6InitializationJournal(root, setup.config, setup.target.operation_id, source, metadata);
    let settled!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { settled = resolve; });
    const effects = { createResources: async () => {}, deploy: async () => {
      entered(); await pending; return { deployment_id: setup.target.deployment_id, worker_version_id: setup.versionId };
    }, initialize: async () => setup.readiness };
    const running = runFreshM6Initialization(journal, effects, source, metadata);
    await ready;
    try {
       expect(existsSync(join(root, ".castloop", "service-initializations", `${setup.config.service_id}.json.lock`))).toBe(true);
       expect(readLocalFreshM6Initialization(root, setup.config)).toEqual({ state: journal.load(), lockPresent: true });
      await expect(other.exclusively(async () => {})).rejects.toThrow();
    } finally { settled(); await running; }
    const secondRoot = mkdtempSync("/tmp/opencode/castloop-fresh-init-resume-");
    try {
      const retained = await createFreshM6InitializationJournal(secondRoot, setup.config, setup.target.operation_id, source, metadata);
      await retained.exclusively(async () => {
        for (const phase of ["resources_requested", "resources_created", "deploy_requested"] as const) retained.save({ ...retained.load(), phase });
        retained.save({ ...retained.load(), phase: "deployed", target: setup.target });
      });
      await resumeFreshM6Initialization(retained, { createResources: async () => { throw new Error("No resource replay"); },
        deploy: async () => { throw new Error("No PUT replay"); }, initialize: async () => setup.readiness });
      expect(retained.load().phase).toBe("initialized");
    } finally { rmSync(secondRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
