import { afterEach, expect, test } from "bun:test";
import { LogpushCloudflare } from "./logpush-cloudflare";
import { LOGPUSH_FIELDS, logpushConfigurationSchema, logpushConfigurationStorage, logpushFilter, readLogpushConfiguration } from "./logpush-config";
import { runLogpushCommand } from "./logpush";
import { runSqliteCommand } from "./sqlite-commands";
import { createLocalBackup } from "./backup-create";
import { previewBackupRestore, restoreLocalBackup } from "./backup-restore";
import { sha256HexSync } from "./sha256";
import { logpushFixture } from "./test-support/logpush";
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Fixture = Awaited<ReturnType<typeof logpushFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
async function fixture() { const f = await logpushFixture(); fixtures.push(f); return f; }
function run(f: Fixture, action = "setup") {
  return runLogpushCommand(f.root, f.config, action, { zoneId: f.zoneId, ...(action === "setup" ? { bucketName: "access-logs" } : {}) }, f.options);
}
function record(f: Fixture) { return readLogpushConfiguration(f.root, f.config)!; }
function recordFile(f: Fixture) { return logpushConfigurationStorage(f.root, f.config).path; }
function mutations(f: Fixture) { return f.calls.filter((call) => call.method !== "GET"); }

test("setup creates private 400-day Standard log storage and one privacy-safe bucket-scoped Logpush job", async () => {
  const f = await fixture(), original = readFileSync(join(f.root, "castloop.toml"), "utf8");
  const result = await run(f);
  expect(result).toMatchObject({ result: "logpush-configured", retention_days: 400, private: true, settings: { enabled: true, hosts: ["podcasts.example.com"] } });
  expect(f.buckets).toEqual(new Set(["access-logs"])); expect(f.jobs).toHaveLength(1); expect(f.tokens).toHaveLength(1);
  expect(f.rules).toEqual([{ id: "castloop-access-service", enabled: true, conditions: { prefix: "http/service/" },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: 34_560_000 } } }]);
  expect(f.tokens[0]!.policies).toEqual([{ effect: "allow", permission_groups: [{ id: f.permissionId }],
    resources: { [`com.cloudflare.edge.r2.bucket.${f.config.account_id}_default_access-logs`]: "*" } }]);
  const destination = new URL(f.jobs[0]!.destination_conf);
  expect(destination.pathname).toBe(`/http/service/${f.zoneId}/%7BDATE%7D/`);
  expect(destination.searchParams.get("secret-access-key")).toBe(sha256HexSync("destination-secret"));
  expect(f.jobs[0]!.output_options).toEqual({ field_names: [...LOGPUSH_FIELDS], sample_rate: 1, timestamp_format: "rfc3339" });
  expect(f.jobs[0]!.filter).toBe(logpushFilter(["podcasts.example.com"]));
  const serialized = readFileSync(recordFile(f), "utf8") + JSON.stringify(result);
  for (const secret of ["private-token", "destination-secret", "private@example.com", "destination_conf", sha256HexSync("destination-secret")]) expect(serialized).not.toContain(secret);
  expect(statSync(recordFile(f)).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.root, ".castloop", "logpush")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(f.root, "castloop.toml"), "utf8")).toBe(original);
  f.calls.length = 0;
  expect(await run(f)).toMatchObject({ job_id: f.jobs[0]!.id }); expect(mutations(f)).toEqual([]);
});

test("status is read-only, reports safe delivery health, and enable/disable retain logs and record interruptions", async () => {
  const f = await fixture(); await run(f);
  const started = record(f).zones[0]!.sources[0]!.collection_started_at_ms;
  f.jobs[0]!.last_error = new Date(started + 100).toISOString();
  f.jobs[0]!.last_complete = new Date(started + 200).toISOString();
  f.jobs[0]!.error_message = "private-token private@example.com";
  const saved = readFileSync(recordFile(f), "utf8"); f.calls.length = 0;
  const status = await run(f, "status");
  expect(status).toMatchObject({ configuration_matches: true, retention_valid: true, delivery_error: true,
    sources: [{ last_complete_at_ms: started + 200, interruptions: expect.arrayContaining([
      { started_at_ms: started + 100, ended_at_ms: started + 200, reason_code: "delivery_error" },
    ]) }] });
  expect(JSON.stringify(status)).not.toContain("private@example.com"); expect(mutations(f)).toEqual([]);
  expect(readFileSync(recordFile(f), "utf8")).toBe(saved);
  await run(f, "disable");
  expect(f.jobs[0]!.enabled).toBe(false);
  expect(record(f).zones[0]!.sources[0]!.interruptions.some((entry) => entry.reason_code === "job_disabled" && entry.ended_at_ms === null)).toBe(true);
  const disabled = record(f).zones[0]!.sources[0]!.interruptions.findLast((entry) => entry.reason_code === "job_disabled")!;
  await run(f, "enable");
  expect(f.jobs[0]!.enabled).toBe(true);
  expect(record(f).zones[0]!.sources[0]!.interruptions.find((entry) => entry.started_at_ms === disabled.started_at_ms && entry.reason_code === "job_disabled")!.ended_at_ms).not.toBeNull();
  expect(f.tokens).toHaveLength(1); expect(f.buckets.size).toBe(1); expect(f.rules).toHaveLength(1);
});

for (const stage of ["bucket", "lifecycle", "token", "job"] as const) {
  test(`an unknown ${stage} creation response is inspected before an explicit setup rerun without duplicate jobs or retained secrets`, async () => {
    const f = await fixture(); f.faults.lost = stage;
    await expect(run(f)).rejects.toThrow("outcome is unknown");
    expect(mutations(f).filter((call) => stage === "bucket" ? call.path === "/r2/buckets" : stage === "lifecycle" ? call.path.endsWith("/lifecycle") :
      stage === "token" ? call.path === "/tokens" : call.path.endsWith("/logpush/jobs"))).toHaveLength(1);
    expect(readFileSync(recordFile(f), "utf8")).not.toContain("destination-secret");
    f.faults.lost = undefined;
    await run(f);
    expect(f.buckets.size).toBe(1); expect(f.jobs).toHaveLength(1); expect(f.tokens).toHaveLength(1);
    expect(record(f).zones[0]!.job_id).toBe(f.jobs[0]!.id);
    if (stage === "token") expect(f.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/tokens/"))).toHaveLength(1);
  });
}

test("an interrupted enable/disable converges on the saved settings and status does not mutate it", async () => {
  const f = await fixture(); await run(f); f.faults.lost = "update";
  await expect(run(f, "disable")).rejects.toThrow("outcome is unknown");
  expect(f.jobs[0]!.enabled).toBe(false); expect(record(f).zones[0]!.settings.enabled).toBe(false);
  f.faults.lost = undefined; f.calls.length = 0;
  expect(await run(f, "status")).toMatchObject({ configuration_matches: true }); expect(mutations(f)).toEqual([]);
  await run(f, "disable"); expect(mutations(f)).toEqual([]);
  await run(f, "enable"); expect(f.jobs[0]!.enabled).toBe(true);
});

test("an unknown unused-token revocation is inspected on the next explicit setup without touching logs", async () => {
  const f = await fixture(); f.faults.lost = "token";
  await expect(run(f)).rejects.toThrow("outcome is unknown");
  f.faults.lost = "delete-token";
  await expect(run(f)).rejects.toThrow("outcome is unknown");
  expect(f.tokens).toHaveLength(0); expect(f.jobs).toHaveLength(0); expect(f.buckets.size).toBe(1);
  f.faults.lost = undefined;
  await run(f); expect(f.tokens).toHaveLength(1); expect(f.jobs).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/tokens/"))).toHaveLength(1);
});

test("setup adds the current custom host to its zone while preserving the previous host, sources and stopped state", async () => {
  const f = await fixture(); await run(f); await run(f, "disable");
  const previous = record(f).zones[0]!;
  f.config = await f.changeHost("new.example.com");
  await run(f);
  expect(f.jobs).toHaveLength(1); expect(f.tokens).toHaveLength(1);
  expect(record(f).zones[0]).toMatchObject({ operation_id: previous.operation_id, job_id: previous.job_id,
    settings: { hosts: ["new.example.com", "podcasts.example.com"], enabled: false }, previous_settings: previous.settings });
  expect(record(f).zones[0]!.sources.find((source) => source.host === "podcasts.example.com")!.collection_started_at_ms)
    .toBe(previous.sources[0]!.collection_started_at_ms);
  expect(f.jobs[0]!.filter).toBe(logpushFilter(["new.example.com", "podcasts.example.com"]));
  await run(f, "enable");
  f.config = await f.changeHost("test-worker.example.workers.dev");
  expect(await run(f, "status")).toMatchObject({ configuration_matches: true });
  await run(f, "disable"); expect(f.jobs[0]!.enabled).toBe(false);
});

test("setup rejects unrelated resources, wrong zones, missing dataset fields and incomplete inventories before mutation", async () => {
  for (const fault of ["existing", "wrongAccount", "missingField", "incompleteTokens"] as const) {
    const f = await fixture();
    if (fault === "existing") f.buckets.add("access-logs"); else f.faults[fault] = true;
    await expect(run(f)).rejects.toThrow(); expect(mutations(f)).toEqual([]);
    expect(existsSync(recordFile(f))).toBe(false);
  }
});

test("privacy and lifecycle checks preserve unrelated rules and stop before activating logs when retention is unsafe", async () => {
  for (const fault of ["public", "customDomain", "conflict"] as const) {
    const f = await fixture(); f.faults.lost = "bucket"; await expect(run(f)).rejects.toThrow(); f.faults.lost = undefined;
    if (fault === "conflict") f.rules.push({ id: "short-retention", enabled: true, conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } }); else f.faults[fault] = true;
    f.calls.length = 0; await expect(run(f)).rejects.toThrow(fault === "conflict" ? "overlapping" : "r2.dev");
    expect(f.jobs).toHaveLength(0); expect(f.tokens).toHaveLength(0); expect(mutations(f)).toEqual([]);
  }
  const f = await fixture(); f.rules.push({ id: "multipart", enabled: true, conditions: { prefix: "" },
    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } });
  await run(f); expect(f.rules).toHaveLength(2); expect(f.rules[0]).toMatchObject({ id: "multipart" });
});

test("managed job privacy/target changes, broadened token scopes and missing saved jobs are not adopted", async () => {
  for (const fault of ["fields", "destination", "filter", "token", "missing"] as const) {
    const f = await fixture(); await run(f); f.calls.length = 0;
    if (fault === "fields") f.jobs[0]!.output_options.field_names.push("ClientIP");
    if (fault === "destination") f.jobs[0]!.destination_conf = f.jobs[0]!.destination_conf.replace("access-logs", "other-bucket");
    if (fault === "filter") f.jobs[0]!.filter = JSON.stringify({ where: { and: [] } });
    if (fault === "token") f.tokens[0]!.policies = [];
    if (fault === "missing") f.jobs.length = 0;
    await expect(run(f)).rejects.toThrow(); expect(mutations(f)).toEqual([]);
  }
});

test("API failures are bounded and privacy-safe without mutation retries", async () => {
  for (const fault of ["failStatus", "range", "corruptJson", "oversized"] as const) {
    const f = await fixture();
    if (fault === "failStatus") f.faults.failStatus = 403; else f.faults[fault] = true;
    let message = ""; try { await run(f); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("not verified"); expect(message).not.toContain("destination-secret");
    expect(message).not.toContain("private@example.com"); expect(f.calls).toHaveLength(1); expect(mutations(f)).toEqual([]);
  }
});

test("token inventories include all pages and unrelated jobs do not need the managed HTTP output format", async () => {
  const f = await fixture();
  for (let index = 0; index < 51; index++) f.tokens.push({ id: (index + 100).toString(16).padStart(32, "0"), name: `unrelated-${index}`, status: "active", policies: [] });
  await run(f);
  expect(f.calls.some((call) => call.path.includes("tokens?page=2"))).toBe(true);
  const other = { id: 9999, name: "unrelated-job", dataset: "firewall_events" };
  const transport = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input).endsWith("/logpush/jobs") ? Response.json({ success: true, result: [...f.jobs, other] }) : f.transport(input, init);
  const api = new LogpushCloudflare(f.config, { ...f.options, transport });
  expect(await api.jobs(record(f).zones[0]!)).toHaveLength(1);
});

test("local configuration validates scope, sizes and paths, and new records participate in encrypted backup/restore", async () => {
  const f = await fixture(); await run(f);
  const value = record(f);
  expect(() => readLogpushConfiguration(f.root, { ...f.config, worker_name: "other-worker" })).toThrow("another service");
  expect(logpushConfigurationSchema.safeParse({ ...value, destination_conf: "secret" }).success).toBe(false);
  expect(logpushConfigurationSchema.safeParse({ ...value, zones: [...value.zones, ...value.zones] }).success).toBe(false);
  expect(logpushConfigurationSchema.safeParse({ ...value, bucket_name: f.config.bucket_name }).success).toBe(false);
  const large = structuredClone(value);
  large.zones[0]!.sources[0]!.interruptions = Array.from({ length: 300 }, () => ({
    started_at_ms: value.created_at_ms, ended_at_ms: null, reason_code: "delivery_error" as const }));
  expect(logpushConfigurationSchema.safeParse(large).success).toBe(false);
  expect(() => logpushFilter(Array.from({ length: 20 }, (_, index) => `${index}-${"a".repeat(40)}.example.com`))).toThrow("1000-byte");
  const archive = join(f.root, "logs.clbk"), target = join(f.root, "restored");
  await createLocalBackup(f.root, archive, { includeAudio: false, passphrase: "logpush-test-passphrase" });
  const preview = previewBackupRestore(archive, target, "logpush-test-passphrase");
  expect(preview.entries.some((entry) => entry.path === ".castloop/logpush/service/configuration.json")).toBe(true);
  restoreLocalBackup(archive, target, "logpush-test-passphrase");
  expect(readLogpushConfiguration(target, f.config)).toEqual(value);
  const other = await fixture();
  symlinkSync(f.root, join(other.root, ".castloop", "logpush"));
  await expect(run(other)).rejects.toThrow("real directories"); expect(mutations(other)).toEqual([]);
});

test("command routing rejects malformed setup inputs and workers.dev without writes or HTTP", async () => {
  const f = await fixture();
  for (const options of [{ zoneId: "invalid", bucketName: "access-logs" }, { zoneId: f.zoneId },
    { zoneId: f.zoneId, bucketName: f.config.bucket_name }]) {
    await expect(runSqliteCommand(f.root, f.config, "logpush", ["setup"], { cloudflare: f.options, logpushOptions: options })).rejects.toThrow();
  }
  await expect(runLogpushCommand(f.root, { ...f.config, public_base_url: f.config.workers_dev_base_url }, "setup",
    { zoneId: f.zoneId, bucketName: "access-logs" }, f.options)).rejects.toThrow();
  expect(f.calls).toEqual([]); expect(existsSync(recordFile(f))).toBe(false);
  expect(readdirSync(join(f.root, ".castloop"))).not.toContain("logpush");
  await runSqliteCommand(f.root, f.config, "logpush", ["setup"], { cloudflare: f.options, logpushOptions: { zoneId: f.zoneId, bucketName: "access-logs" } });
  const saved = readFileSync(recordFile(f), "utf8");
  writeFileSync(recordFile(f), saved.replace('"service_id":"service"', '"service_id":"other"'));
  await expect(run(f)).rejects.toThrow("another service");
});
