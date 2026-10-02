import { lifecycleAdminRequestSchema, stringifyToml } from "@castloop/shared";
import { createLifecycleJournal } from "../lifecycle-journal";
import { createPublicationJournal } from "../publication-journal";
import { createShowRegistrationJournal } from "../show-registration-journal";
import { createStagingJournal } from "../staging-journal";
import { fetchM6ManagementIntegration } from "../../../../src/m6-routes";
import { lifecycleAdminFixture } from "../../../../src/test-support/lifecycle-admin";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "dist/castloop-linux-x64");
if (!existsSync(binary)) throw new Error("Build the Linux CLI binary before this local-only verification");
const root = mkdtempSync("/tmp/opencode/castloop-status-binary-");
const cert = join(root, "localhost-cert.pem");
const key = join(root, "localhost-key.pem");
let server: ReturnType<typeof Bun.serve> | undefined;

function requireCheck(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function snapshot(path: string): Array<{ path: string; hash: string; mtime: number }> {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? snapshot(file) : [{ path: file, hash: new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex"),
      mtime: statSync(file).mtimeMs }];
  });
}

try {
  const certificate = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
    { stdout: "pipe", stderr: "pipe" });
  requireCheck(certificate.exitCode === 0, "Could not prepare the isolated local TLS certificate");
  const setup = await lifecycleAdminFixture();
  const calls: Array<{ path: string; action: unknown }> = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
    fetch: async (request) => {
      const body = await request.clone().json() as { action?: unknown };
      calls.push({ path: new URL(request.url).pathname, action: body.action });
      if (request.method !== "POST" || body.action !== "status") return new Response(null, { status: 400 });
      return fetchM6ManagementIntegration(request as never, setup.candidateEnv, setup.cachedAssets);
    } });
  const config = { ...setup.config, public_base_url: `https://127.0.0.1:${server.port}` };
  writeFileSync(join(root, "castloop.toml"), stringifyToml(config));
  const staging = createStagingJournal(root, config, setup.stages[0]!);
  const publication = createPublicationJournal(root, config, setup.frozen);
  const request = await setup.operationRequest("show", "unpublish");
  const claim = lifecycleAdminRequestSchema.parse(await setup.body("claim", request));
  if (claim.action !== "claim") throw new Error("Expected lifecycle claim");
  const lifecycle = createLifecycleJournal(root, config, claim);
  await setup.success(claim);
  const registration = createShowRegistrationJournal(root, config, { schema_version: 1, service_id: config.service_id,
    show_id: "new-show", reservation_id: crypto.randomUUID(), action: "reserve" });
  await staging.exclusively(async () => { staging.save({ ...staging.load(), phase: "claim_requested" }); });
  await publication.exclusively(async () => { publication.save({ ...publication.load(), phase: "claim_requested" }); });
  await lifecycle.exclusively(async () => { lifecycle.save({ ...lifecycle.load(), phase: "claim_requested" }); });
  await registration.exclusively(async () => { registration.save({ ...registration.load(), phase: "reserve_requested" }); });
  const operations = [
    { family: "staging", id: setup.stages[0]!.operation_id, directory: "staging-uploads", phase: "claim_requested" },
    { family: "publication", id: setup.frozen.request.job_id, directory: "publication-jobs", phase: "claim_requested" },
    { family: "lifecycle", id: request.job_id, directory: "lifecycle-jobs", phase: "claim_requested" },
    { family: "show-registration", id: "new-show", directory: "show-registrations", phase: "reserve_requested" },
  ];
  for (const operation of operations) {
    const lock = join(root, ".castloop", operation.directory, config.service_id, `${operation.id}.json.lock`);
    writeFileSync(lock, "keep unknown old lock", { mode: 0o600 });
    utimesSync(lock, 0, 0);
  }
  writeFileSync(join(root, ".castloop", "secrets.json"), JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" }), { mode: 0o600 });
  writeFileSync(join(root, ".castloop", "state.json"), "unreadable legacy state");
  const before = JSON.stringify(snapshot(root));
  const remoteBefore = JSON.stringify([...setup.entries].map(([name, value]) => ({ name, etag: value.etag,
    hash: new Bun.CryptoHasher("sha256").update(value.bytes).digest("hex") })));
  const writes = setup.writes.length;
  const sent = JSON.stringify(setup.sent);
  const purges = JSON.stringify(setup.purges);
  for (const operation of operations) {
    const child = Bun.spawn([binary, "operation-status", operation.family, operation.id], { cwd: root,
      env: { PATH: process.env.PATH ?? "", NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    requireCheck(exit === 0, `Standalone ${operation.family} inspection failed: ${error}`);
    const report = JSON.parse(output) as { family: string; remote_state_checked: boolean; lock_present: boolean;
      authorizes_mutation: boolean; authorizes_recovery: boolean; client_state: { phase: string }; server_status: { result: string } };
    requireCheck(report.family === operation.family && report.remote_state_checked && report.lock_present &&
      !report.authorizes_mutation && !report.authorizes_recovery && report.client_state.phase === operation.phase &&
      report.server_status.result === "status" && !output.includes("private-secret"), "Standalone report did not preserve read-only boundaries");
    requireCheck(JSON.stringify(snapshot(root)) === before, "Standalone inspection changed local files or old locks");
  }
  requireCheck(calls.length === 4 && calls.every((call) => call.action === "status"), "Standalone inspection sent an unexpected request");
  requireCheck(setup.writes.length === writes && JSON.stringify(setup.sent) === sent && JSON.stringify(setup.purges) === purges &&
    JSON.stringify([...setup.entries].map(([name, value]) => ({ name, etag: value.etag,
      hash: new Bun.CryptoHasher("sha256").update(value.bytes).digest("hex") }))) === remoteBefore, "Standalone inspection changed simulated remote records");
  console.log(JSON.stringify({ result: "standalone_readonly_operation_status_passed", families: operations.map((operation) => operation.family),
    transport: "local_https", remote: "simulated_m6_management", requests: calls.length, cloudflare_credentials_present: false,
    local_files_unchanged: true, old_locks_preserved: true, remote_records_unchanged: true, authorizes_mutation: false, authorizes_recovery: false }));
} finally {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
