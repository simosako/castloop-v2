import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMigrationDeploymentJournal, migrationPayloadHash, resumeMigrationCandidateSettlement,
  runMigrationCandidateDeployment } from "./migration-deployment";
import type { MigrationDeploymentEffects } from "./migration-deployment";
import { bootstrapFixture } from "../../../src/test-support/bootstrap";

async function fixture() {
  const server = await bootstrapFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-migration-journal-");
  const source = "export default {};";
  const metadata = { main_module: "index.js", bindings: [{ name: "CASTLOOP_ADMIN_KEY", type: "inherit" }] };
  const request = { ...server.bootstrapRequest, worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) };
  const journal = createMigrationDeploymentJournal(root, request);
  const calls: string[] = [];
  const effects: MigrationDeploymentEffects = {
    prepare: async () => { calls.push("prepare"); }, begin: async () => { calls.push("begin"); return { bootstrap_id: request.bootstrap_id, start_allowed: true }; },
    deploy: async () => { calls.push("deploy"); expect(journal.load().phase).toBe("uploading"); return server.candidateVersion; },
    inspect: async (id) => { calls.push("inspect"); expect(id).toBe(server.candidateVersion); return server.settlement.deployment; },
    settle: async (input, evidence) => { calls.push("settle"); expect(input).toEqual(request); expect(evidence.no_more_deploys).toBe(true); expect(evidence.rest_requests_settled).toBe(true); },
  };
  return { ...server, root, source, metadata, request, journal, calls, effects,
    file: join(root, ".castloop", "migrations", `${request.bootstrap_id}.json`), dispose: () => rmSync(root, { recursive: true }) };
}

describe("durable single-use migration deployment client", () => {
  test("persists a hashed request and monotonic private progress before every mutating boundary", async () => {
    const setup = await fixture();
    try {
      await runMigrationCandidateDeployment(setup.journal, setup.effects, setup.source, setup.metadata);
      expect(setup.calls).toEqual(["prepare", "begin", "deploy", "inspect", "settle"]);
      expect(setup.journal.load().phase).toBe("settled");
      expect(statSync(setup.file).mode & 0o777).toBe(0o600);
      expect(statSync(join(setup.root, ".castloop", "migrations")).mode & 0o777).toBe(0o700);
      const data = readFileSync(setup.file, "utf8");
      for (const value of [setup.source, JSON.stringify(setup.metadata), "private-key", "Private description"]) expect(data).not.toContain(value);
      await expect(runMigrationCandidateDeployment(setup.journal, setup.effects, setup.source, setup.metadata)).rejects.toThrow("never automatically replay");
      await resumeMigrationCandidateSettlement(setup.journal, setup.effects);
      expect(setup.calls.filter((call) => call === "deploy")).toHaveLength(1);
    } finally { setup.dispose(); }
  });

  test("source/metadata mismatch, changed frozen request and missing local lock reject before REST", async () => {
    const setup = await fixture();
    try {
      await expect(runMigrationCandidateDeployment(setup.journal, setup.effects, "another source", setup.metadata)).rejects.toThrow("differs");
      await expect(runMigrationCandidateDeployment(setup.journal, setup.effects, setup.source, {})).rejects.toThrow("differs");
      expect(setup.calls).toEqual([]);
      expect(() => setup.journal.save({ ...setup.journal.load(), phase: "start_requested" })).toThrow("exclusive");
      expect(() => createMigrationDeploymentJournal(setup.root, { ...setup.request, worker_source_sha256: "0".repeat(64) })).toThrow("frozen");
    } finally { setup.dispose(); }
  });

  test("start response loss and failed/ambiguous deployment are never automatically reissued", async () => {
    for (const failure of ["start", "upload", "invalid-version"] as const) {
      const setup = await fixture();
      try {
        const effects = { ...setup.effects,
          ...(failure === "start" ? { begin: async () => { setup.calls.push("begin"); throw new Error("Start response lost"); } } : {}),
          ...(failure === "upload" ? { deploy: async () => { setup.calls.push("deploy"); throw new Error("Deploy outcome unknown"); } } : {}),
          ...(failure === "invalid-version" ? { deploy: async () => { setup.calls.push("deploy"); return "invalid-id"; } } : {}),
        };
        await expect(runMigrationCandidateDeployment(setup.journal, effects, setup.source, setup.metadata)).rejects.toThrow();
        expect(setup.journal.load().phase).toBe(failure === "start" ? "start_requested" : "uploading");
        const reopened = createMigrationDeploymentJournal(setup.root, setup.request);
        await expect(runMigrationCandidateDeployment(reopened, setup.effects, setup.source, setup.metadata)).rejects.toThrow("never automatically replay");
        await expect(resumeMigrationCandidateSettlement(reopened, setup.effects)).rejects.toThrow("outcome is unknown");
        expect(setup.calls.filter((call) => call === "deploy")).toHaveLength(failure === "start" ? 0 : 1);
      } finally { setup.dispose(); }
    }
  });

  test("inspection failure or settlement response loss resumes only GET/settlement, never deploy", async () => {
    for (const failure of ["inspect", "settle"] as const) {
      const setup = await fixture();
      try {
        await expect(runMigrationCandidateDeployment(setup.journal, { ...setup.effects,
          ...(failure === "inspect" ? { inspect: async () => { setup.calls.push("inspect"); throw new Error("Inspect failed"); } } : {}),
          ...(failure === "settle" ? { settle: async () => { setup.calls.push("settle"); throw new Error("Settlement response lost"); } } : {}),
        }, setup.source, setup.metadata)).rejects.toThrow();
        expect(setup.journal.load().phase).toBe("rest_settled");
        await resumeMigrationCandidateSettlement(createMigrationDeploymentJournal(setup.root, setup.request), setup.effects);
        expect(setup.journal.load().phase).toBe("settled");
        expect(setup.calls.filter((call) => call === "deploy")).toHaveLength(1);
        expect(setup.calls.filter((call) => call === "inspect")).toHaveLength(failure === "inspect" ? 2 : 1);
      } finally { setup.dispose(); }
    }
  });

  test("exclusive lock rejects another client during a live PUT and does not expire stale locks", async () => {
    const setup = await fixture();
    try {
      const started = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      const pending = runMigrationCandidateDeployment(setup.journal, { ...setup.effects, deploy: async () => {
        started.resolve(); await ended.promise; return setup.candidateVersion;
      } }, setup.source, setup.metadata);
      await started.promise;
      const another = createMigrationDeploymentJournal(setup.root, setup.request);
      await expect(resumeMigrationCandidateSettlement(another, setup.effects)).rejects.toThrow();
      expect(setup.journal.load().phase).toBe("uploading");
      expect(readdirSync(dirname(setup.file)).some((name) => name.endsWith(".lock"))).toBe(true);
      ended.resolve();
      await pending;
      writeFileSync(`${setup.file}.lock`, "", { flag: "wx" });
      await expect(resumeMigrationCandidateSettlement(another, setup.effects)).rejects.toThrow();
      expect(statSync(`${setup.file}.lock`).isFile()).toBe(true);
    } finally { setup.dispose(); }
  });

  test("local persistence failure after start intent blocks both the start call and future automatic PUT", async () => {
    const setup = await fixture();
    try {
      const journal = { ...setup.journal, save: (input: Parameters<typeof setup.journal.save>[0]) => {
        setup.journal.save(input);
        if (input.phase === "start_requested") throw new Error("Journal persistence outcome uncertain");
      } };
      await expect(runMigrationCandidateDeployment(journal, setup.effects, setup.source, setup.metadata)).rejects.toThrow("uncertain");
      expect(setup.calls).toEqual(["prepare"]);
      await expect(runMigrationCandidateDeployment(createMigrationDeploymentJournal(setup.root, setup.request), setup.effects,
        setup.source, setup.metadata)).rejects.toThrow("never automatically replay");
    } finally { setup.dispose(); }
  });
});
