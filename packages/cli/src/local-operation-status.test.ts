import { expect, test } from "bun:test";
import { lifecycleAdminRequestSchema, stringifyToml } from "@castloop/shared";
import { publicationAdminFixture } from "../../../src/test-support/publication-admin";
import { createLifecycleJournal } from "./lifecycle-journal";
import { readLocalOperationStatus } from "./local-operation-status";
import { createPublicationJournal } from "./publication-journal";
import { createStagingJournal } from "./staging-journal";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = await publicationAdminFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-offline-status-");
  writeFileSync(join(root, "castloop.toml"), stringifyToml(setup.config));
  const staging = createStagingJournal(root, setup.config, setup.stages[0]!);
  const publication = createPublicationJournal(root, setup.config, setup.frozen);
  const request = { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "show", action: "unpublish",
    expected_show_generation: setup.frozen.request.expected_show_generation, created_at: "2026-10-02T12:00:00Z" };
  const claim = lifecycleAdminRequestSchema.parse({ schema_version: 1, service_id: setup.config.service_id, action: "claim", request,
    confirmation: { operator_confirmed: true, request_sha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") } });
  if (claim.action !== "claim") throw new Error("Expected lifecycle claim");
  const lifecycle = createLifecycleJournal(root, setup.config, claim);
  const operations = [{ family: "staging", id: setup.stages[0]!.operation_id, directory: "staging-uploads", state: staging.load() },
    { family: "publication", id: setup.frozen.request.job_id, directory: "publication-jobs", state: publication.load() },
    { family: "lifecycle", id: request.job_id, directory: "lifecycle-jobs", state: lifecycle.load() }];
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), "local-operation-status", ...args],
    { cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } });
  return { ...setup, root, operations, run };
}

test("offline CLI reads all M6 journal families without secrets/network/writes and preserves leftover locks", async () => {
  const setup = await fixture();
  writeFileSync(join(setup.root, ".castloop", "state.json"), "invalid legacy state must not be loaded");
  writeFileSync(join(setup.root, ".castloop", "secrets.json"), "invalid secrets must not be loaded");
  for (const operation of setup.operations) {
    const file = join(setup.root, ".castloop", operation.directory, setup.config.service_id, `${operation.id}.json`);
    writeFileSync(`${file}.lock`, "existing lock, not a timeout lease");
    const original = readFileSync(file, "utf8");
    const before = readdirSync(join(setup.root, ".castloop"), { recursive: true });
    const result = setup.run(operation.family, operation.id);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const value = JSON.parse(result.stdout.toString());
    expect(value).toEqual({ family: operation.family, operation_id: operation.id, client_state: operation.state,
      lock_present: true, remote_state_checked: false, authorizes_mutation: false, authorizes_recovery: false });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(`${file}.lock`, "utf8")).toBe("existing lock, not a timeout lease");
    expect(readdirSync(join(setup.root, ".castloop"), { recursive: true })).toEqual(before);
    for (const secret of ["private-secret", "Private description", "owner@example.com", "New Show title"]) expect(result.stdout.toString()).not.toContain(secret);
  }
});

test("missing local journals remain unknown and an empty workspace is not modified", async () => {
  const setup = await fixture();
  const root = mkdtempSync("/tmp/opencode/castloop-offline-empty-");
  writeFileSync(join(root, "castloop.toml"), stringifyToml(setup.config));
  for (const family of ["staging", "publication", "lifecycle"]) {
    const id = crypto.randomUUID();
    const result = readLocalOperationStatus(root, setup.config, family, id);
    expect(result.client_state).toBeNull();
    expect(result.remote_state_checked).toBe(false);
    expect(result.authorizes_recovery).toBe(false);
    expect(result.authorizes_mutation).toBe(false);
  }
  expect(existsSync(join(root, ".castloop"))).toBe(false);
  expect(readdirSync(root)).toEqual(["castloop.toml"]);
});

test("corrupt/oversized/foreign journals fail without rewriting records or leaking their contents", async () => {
  const setup = await fixture();
  for (const operation of setup.operations) {
    const file = join(setup.root, ".castloop", operation.directory, setup.config.service_id, `${operation.id}.json`);
    writeFileSync(`${file}.lock`, "keep");
    for (const text of ["invalid private-token-json", "x".repeat(16385), JSON.stringify({ ...operation.state, secret: "private-token" }),
      JSON.stringify({ ...operation.state, identity: { ...operation.state.identity, account_id: "f".repeat(32) } })]) {
      writeFileSync(file, text);
      const result = setup.run(operation.family, operation.id);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("could not be verified");
      expect(result.stderr.toString()).not.toContain("private-token");
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(readFileSync(`${file}.lock`, "utf8")).toBe("keep");
    }
  }
});

test("offline command rejects unknown family, traversal IDs, unexpected flags and wrong arity", async () => {
  const setup = await fixture();
  for (const args of [["unknown", crypto.randomUUID()], ["publication", "../foreign"], ["__proto__", crypto.randomUUID()],
    ["publication"], ["publication", crypto.randomUUID(), "extra"], ["publication", crypto.randomUUID(), "--retry", "true"]]) {
    const result = setup.run(...args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
  }
});
