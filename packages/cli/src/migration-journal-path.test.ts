import { expect, test } from "bun:test";
import { migrationBridgeDeploymentRequestSchema } from "@castloop/shared";
import { createMigrationBridgeJournal } from "./migration-bridge-journal";
import { createMigrationDeploymentJournal } from "./migration-deployment";
import { createMigrationSetupJournal, readLocalMigrationSetup } from "./migration-setup-journal";
import { bridgeDeploymentFixture } from "./test-support/migration-bridge";
import { migrationSetupFixture } from "./test-support/migration-setup";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = await migrationSetupFixture();
  const bridge = bridgeDeploymentFixture();
  const preparation = await bridge.prepare();
  const bridgeRequest = migrationBridgeDeploymentRequestSchema.parse({ schema_version: 1, preparation: preparation.request,
    administrator_writes_stopped: true, other_deployers_stopped: true });
  const cases = [
    { family: "bridge-deployments", id: bridgeRequest.preparation.service_id,
      create: (root: string) => createMigrationBridgeJournal(root, bridgeRequest) },
    { family: "migrations", id: setup.bootstrapRequest.bootstrap_id,
      create: (root: string) => createMigrationDeploymentJournal(root, setup.bootstrapRequest) },
    { family: "migration-setups", id: setup.request.bridge.service_id,
      create: (root: string) => createMigrationSetupJournal(root, setup.request) },
  ];
  return { ...setup, cases };
}

test("all three migration journal layouts reject symlink parents without creating outside records", async () => {
  const setup = await fixture();
  try {
    for (const family of setup.cases) for (const level of ["root", "state", "family"]) {
      const base = mkdtempSync("/tmp/opencode/castloop-migration-parent-");
      const root = join(base, "workspace");
      const outside = join(base, "outside");
      mkdirSync(outside);
      try {
        if (level !== "root") mkdirSync(root);
        if (level === "family") mkdirSync(join(root, ".castloop"));
        symlinkSync(outside, level === "root" ? root : level === "state" ? join(root, ".castloop") : join(root, ".castloop", family.family));
        expect(() => family.create(root)).toThrow("real directories");
        expect(readdirSync(outside)).toEqual([]);
      } finally { rmSync(base, { recursive: true, force: true }); }
    }
  } finally { setup.dispose(); }
});

test("migration records are bounded, regular, no-follow inputs and retained locks cannot synthesize missing requests", async () => {
  const setup = await fixture();
  try {
    for (const family of setup.cases) {
      const root = mkdtempSync("/tmp/opencode/castloop-migration-record-");
      try {
        const journal = family.create(root);
        const file = join(root, ".castloop", family.family, `${family.id}.json`);
        const outside = join(root, "outside.json");
        writeFileSync(outside, readFileSync(file));
        rmSync(file);
        symlinkSync(outside, file);
        expect(() => journal.load()).toThrow();
        expect(() => family.create(root)).toThrow();
        rmSync(file);
        symlinkSync(join(root, "missing-target"), `${file}.lock`);
        expect(() => family.create(root)).toThrow("retained");
        expect(existsSync(file)).toBe(false);
        if (family.family === "migration-setups") expect(readLocalMigrationSetup(root, setup.config).lock_present).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  } finally { setup.dispose(); }
});

test("migration callbacks preserve a replacement client lock instead of deleting another owner's evidence", async () => {
  const setup = await fixture();
  try {
    for (const family of setup.cases) {
      const root = mkdtempSync("/tmp/opencode/castloop-migration-lock-");
      try {
        const journal = family.create(root);
        const lock = join(root, ".castloop", family.family, `${family.id}.json.lock`);
        await expect(journal.exclusively(async () => {
          rmSync(lock);
          writeFileSync(lock, "different-owner");
        })).rejects.toThrow("changed client lock");
        expect(readFileSync(lock, "utf8")).toBe("different-owner");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  } finally { setup.dispose(); }
});
