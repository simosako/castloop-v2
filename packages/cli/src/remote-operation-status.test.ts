import { describe, expect, test } from "bun:test";
import { lifecycleAdminRequestSchema, stringifyToml } from "@castloop/shared";
import { createLifecycleJournal } from "./lifecycle-journal";
import type { M6AdminTransport } from "./m6-admin-json";
import { createPublicationJournal } from "./publication-journal";
import { readRemoteOperationStatus } from "./remote-operation-status";
import { createShowRegistrationJournal } from "./show-registration-journal";
import { createStagingJournal } from "./staging-journal";
import { fetchM6Candidate, fetchM6ManagementIntegration } from "../../../src/m6-routes";
import { lifecycleAdminFixture } from "../../../src/test-support/lifecycle-admin";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = await lifecycleAdminFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-remote-status-");
  writeFileSync(join(root, "castloop.toml"), stringifyToml(setup.config));
  const staging = createStagingJournal(root, setup.config, setup.stages[0]!);
  const publication = createPublicationJournal(root, setup.config, setup.frozen);
  const request = await setup.operationRequest("show", "unpublish");
  const claim = lifecycleAdminRequestSchema.parse({ schema_version: 1, service_id: setup.config.service_id, action: "claim", request,
    confirmation: { operator_confirmed: true, request_sha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") } });
  if (claim.action !== "claim") throw new Error("Expected claim");
  createLifecycleJournal(root, setup.config, claim);
  await setup.success(claim);
  createShowRegistrationJournal(root, setup.config, { schema_version: 1, service_id: setup.config.service_id,
    show_id: "new-show", reservation_id: crypto.randomUUID(), action: "reserve" });
  writeFileSync(join(root, ".castloop", "secrets.json"), JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" }), { mode: 0o600 });
  writeFileSync(join(root, ".castloop", "state.json"), "unreadable legacy state");
  const operations = [
    { family: "staging", id: setup.stages[0]!.operation_id, directory: "staging-uploads", route: "staging" },
    { family: "publication", id: setup.frozen.request.job_id, directory: "publication-jobs", route: "publication" },
    { family: "lifecycle", id: request.job_id, directory: "lifecycle-jobs", route: "lifecycle" },
    { family: "show-registration", id: "new-show", directory: "show-registrations", route: "shows" },
  ].map((operation) => ({ ...operation, file: join(root, ".castloop", operation.directory, setup.config.service_id, `${operation.id}.json`) }));
  const calls: Request[] = [];
  const transport: M6AdminTransport = async (input, init) => {
    const http = new Request(input, init);
    calls.push(http.clone());
    return fetchM6ManagementIntegration(http as never, setup.candidateEnv, setup.cachedAssets);
  };
  return { ...setup, root, staging, publication, operations, calls, transport,
    inspect: (index: number, custom: M6AdminTransport = transport) => readRemoteOperationStatus(root, setup.config,
      operations[index]!.family, operations[index]!.id, () => "private-secret", custom),
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function snapshot(root: string): Array<{ path: string; bytes: Buffer; mtime: number }> {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? snapshot(path) : [{ path, bytes: readFileSync(path), mtime: statSync(path).mtimeMs }];
  });
}

describe("read-only M6 operation-status", () => {
  test("all four families use frozen status requests and preserve local files, locks and remote records", async () => {
    const setup = await fixture();
    try {
      for (const operation of setup.operations) writeFileSync(`${operation.file}.lock`, "keep unknown lock");
      const before = snapshot(setup.root);
      const remoteBefore = [...setup.entries].map(([key, value]) => ({ key, bytes: value.bytes.slice(), etag: value.etag }));
      const writes = setup.writes.length;
      const sent = [...setup.sent];
      const purges = [...setup.purges];
      for (let index = 0; index < setup.operations.length; index++) {
        const result = await setup.inspect(index);
        expect(result).toMatchObject({ family: setup.operations[index]!.family, operation_id: setup.operations[index]!.id,
          lock_present: true, remote_state_checked: true, authorizes_mutation: false, authorizes_recovery: false,
          client_state: { phase: "prepared" }, server_status: { result: "status" } });
        expect(JSON.stringify(result)).not.toContain("private-secret");
        expect(JSON.stringify(result)).not.toContain("Private description");
      }
      expect(snapshot(setup.root)).toEqual(before);
      expect([...setup.entries].map(([key, value]) => ({ key, bytes: value.bytes, etag: value.etag }))).toEqual(remoteBefore);
      expect(setup.writes.length).toBe(writes);
      expect(setup.sent).toEqual(sent);
      expect(setup.purges).toEqual(purges);
      expect(setup.calls).toHaveLength(4);
      for (const call of setup.calls) {
        expect(call.method).toBe("POST");
        expect(await call.json()).toMatchObject({ action: "status" });
      }
    } finally { setup.dispose(); }
  });

  test("server completion does not promote an unknown local phase or recreate upload permission", async () => {
    const setup = await fixture();
    try {
      await setup.staging.exclusively(async () => {
        setup.staging.save({ ...setup.staging.load(), phase: "claim_requested" });
      });
      const before = snapshot(setup.root);
      const result = await setup.inspect(0);
      expect(result.client_state?.phase).toBe("claim_requested");
      expect(result.server_status).toMatchObject({ result: "status", progress: { phase: "finished", outcome: "staged" } });
      expect(result.authorizes_recovery).toBe(false);
      expect(snapshot(setup.root)).toEqual(before);
      expect(setup.calls).toHaveLength(1);
    } finally { setup.dispose(); }
  });

  test("missing, invalid, foreign and symlink records fail before secrets or network access", async () => {
    const setup = await fixture();
    try {
      let keyReads = 0;
      const key = () => { keyReads++; throw new Error("private key error"); };
      for (const [family, id] of [["unknown", crypto.randomUUID()], ["staging", "invalid"], ["publication", crypto.randomUUID()],
        ["show-registration", "missing-show"]]) {
        await expect(readRemoteOperationStatus(setup.root, setup.config, family!, id!, key, setup.transport)).rejects.toThrow("could not be verified");
      }
      const operation = setup.operations[0]!;
      await expect(readRemoteOperationStatus(setup.root, { ...setup.config, worker_name: "foreign-worker" }, operation.family,
        operation.id, key, setup.transport)).rejects.toThrow("could not be verified");
      const linkedId = crypto.randomUUID();
      const linkedFile = join(setup.root, ".castloop", operation.directory, setup.config.service_id, `${linkedId}.json`);
      symlinkSync(operation.file, linkedFile);
      await expect(readRemoteOperationStatus(setup.root, setup.config, operation.family, linkedId, key, setup.transport)).rejects.toThrow("could not be verified");
      writeFileSync(operation.file, "private corrupt record");
      await expect(readRemoteOperationStatus(setup.root, setup.config, operation.family, operation.id, key, setup.transport)).rejects.toThrow("could not be verified");
      expect(readFileSync(operation.file, "utf8")).toBe("private corrupt record");
      expect(keyReads).toBe(0);
      expect(setup.calls).toHaveLength(0);
    } finally { setup.dispose(); }
  });

  test("changes to a local record or lock during HTTP reject the snapshot without repairing it", async () => {
    for (const changed of ["record", "lock"] as const) {
      const setup = await fixture();
      try {
        const operation = setup.operations[0]!;
        const transport: M6AdminTransport = async (input, init) => {
          const response = await setup.transport(input, init);
          if (changed === "lock") writeFileSync(`${operation.file}.lock`, "new live lock");
          else {
            const state = setup.staging.load();
            writeFileSync(operation.file, JSON.stringify({ ...state, phase: "claim_requested" }));
          }
          return response;
        };
        await expect(setup.inspect(0, transport)).rejects.toThrow("could not be verified");
        expect(setup.calls).toHaveLength(1);
        if (changed === "lock") expect(readFileSync(`${operation.file}.lock`, "utf8")).toBe("new live lock");
        else expect(setup.staging.load().phase).toBe("claim_requested");
      } finally { setup.dispose(); }
    }
  });

  test("lost responses, forged identities and unreleased candidate routes never retry or mutate records", async () => {
    for (const mode of ["lost", "forged", "candidate"] as const) {
      const setup = await fixture();
      try {
        const before = snapshot(setup.root);
        const writes = setup.writes.length;
        let requests = 0;
        const transport: M6AdminTransport = async (input, init) => {
          requests++;
          if (mode === "candidate") return fetchM6Candidate(new Request(input, init) as never, setup.candidateEnv, setup.cachedAssets);
          const response = await setup.transport(input, init);
          if (mode === "lost") { await response.body?.cancel(); throw new Error("private transport exception"); }
          const body = await response.json() as Record<string, unknown>;
          return Response.json({ ...body, service_id: "foreign-service" }, { headers: { "Cache-Control": "no-store" } });
        };
        await expect(setup.inspect(0, transport)).rejects.toThrow("could not be verified");
        expect(requests).toBe(1);
        expect(snapshot(setup.root)).toEqual(before);
        expect(setup.writes.length).toBe(writes);
      } finally { setup.dispose(); }
    }
  });

  test("source CLI inspects all four families without Cloudflare credentials or local writes", async () => {
    const setup = await fixture();
    try {
      const preload = join(import.meta.dir, "test-support", "operation-status-fetch.ts");
      for (let index = 0; index < setup.operations.length; index++) {
        const operation = setup.operations[index]!;
        writeFileSync(`${operation.file}.lock`, "keep old lock");
        const report = await setup.inspect(index);
        const request = await setup.calls[index]!.json();
        writeFileSync(join(setup.root, "status-http-fixture.json"), JSON.stringify({ url: `https://current.example/admin/${operation.route}`,
          request, response: report.server_status }));
        const before = snapshot(setup.root);
        const result = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"),
          "operation-status", operation.family, operation.id], { cwd: setup.root,
          env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout.toString())).toEqual(report);
        expect(result.stdout.toString()).not.toContain("private-secret");
        expect(result.stderr.toString()).toContain('"action":"status"');
        expect(snapshot(setup.root)).toEqual(before);
      }
    } finally { setup.dispose(); }
  });

  test("source CLI rejects invalid arguments and missing records before reading malformed secrets", async () => {
    const setup = await fixture();
    try {
      writeFileSync(join(setup.root, ".castloop", "secrets.json"), "private invalid secret");
      const before = snapshot(setup.root);
      for (const args of [[], ["staging", "invalid"], ["staging", crypto.randomUUID()], ["unknown", crypto.randomUUID()],
        ["publication", setup.operations[1]!.id, "--force", "true"], ["show-registration", "new-show", "extra"]]) {
        const result = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "test-support", "operation-status-fetch.ts"),
          join(import.meta.dir, "index.ts"), "operation-status", ...args], { cwd: setup.root,
          env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).toContain("OPERATION_STATUS_TEST_REQUESTS []");
        expect(result.stderr.toString()).not.toContain("private invalid secret");
        expect(snapshot(setup.root)).toEqual(before);
      }
      expect(existsSync(join(setup.root, "status-http-fixture.json"))).toBe(false);
    } finally { setup.dispose(); }
  });
});
