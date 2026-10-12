import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "[LOCAL_TEST_ROOT]";
const label = process.argv[2];
assert(["a8c7e54", "4781fad"].includes(label));
const source = join(root, "build", `castloop-v2-rss-${label}`);
const directory = join(root, "evidence/rss-performance-a8c7e54-fresh-r2/show-investigation", `offline-${label}`);
assert(!existsSync(directory), "Preserve earlier offline evidence");
mkdirSync(directory, { mode: 0o700 });
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error("Network forbidden in offline fixture");
};
const { parseJobStatus, parseLifecycleProgress } = await import(join(source, "packages/shared/src/index.ts"));
const { readShowControl } = await import(join(source, "src/lifecycle-control.ts"));
const { runLifecycleMigrationStep } = await import(join(source, "src/lifecycle-migration-apply.ts"));
const { queueM6Candidate } = await import(join(source, "src/m6-routes.ts"));
const { describeCachedDeliveryRuntime } = await import(join(source, "src/lifecycle-delivery-gate.ts"));
const { readServiceAdmission, resumeServiceAdmission, SERVICE_ADMISSION_KEY } = await import(join(source, "src/service-admission.ts"));
const { migrationFixture } = await import(join(source, "src/test-support/migration.ts"));
const { publicationFixture } = await import(join(source, "src/test-support/publication.ts"));

type Fault = "none" | "one-read-failure" | "persistent-io-failure";
const workerLogs: unknown[] = [];
const originalLog = console.log;
console.log = (...values) => {
  for (const value of values) {
    if (typeof value === "string") {
      try { workerLogs.push(JSON.parse(value)); } catch { workerLogs.push({ unparsed_log: true }); }
    }
  }
};

async function run(fault: Fault) {
  const migration = await migrationFixture();
  for (let index = 0; index < 3; index++) {
    await runLifecycleMigrationStep(migration.env, "service", migration.migrationId, migration.effects);
  }
  await resumeServiceAdmission(migration.env, "service", migration.pauseId, migration.runtime.worker_version_id);
  const fixture = await publicationFixture();
  await fixture.bucket.put(SERVICE_ADMISSION_KEY, migration.entries.get(SERVICE_ADMISSION_KEY)!.data);
  const calls: Array<{ method: string; key: string; phase: string; injected_failure?: boolean }> = [];
  let phase = "before-feed";
  let injected = false;
  let enabled = true;
  const bucket = { ...fixture.bucket };
  for (const method of ["get", "head", "put", "list", "delete"] as const) {
    const original = fixture.bucket[method].bind(fixture.bucket);
    Object.assign(bucket, { [method]: async (...args: unknown[]) => {
      const key = typeof args[0] === "string" ? args[0] : (args[0] as { prefix?: string })?.prefix ?? "unknown";
      const fail = enabled && phase === "after-feed" && fault !== "none" &&
        (fault === "persistent-io-failure" || !injected);
      calls.push({ method, key, phase, ...(fail ? { injected_failure: true } : {}) });
      if (fail) { injected = true; throw new Error("Offline fixture injected IO failure"); }
      const result = await (original as (...arguments_: unknown[]) => Promise<unknown>)(...args);
      if (method === "put" && key === fixture.progressKey && result &&
        parseLifecycleProgress(args[1] as string).phase === "feed") phase = "after-feed";
      return result;
    } });
  }
  let runtimeCalls = 0;
  let purgeCalls = 0;
  const cache = Object.assign(() => ({ fetch: async () => { throw new Error("No public fetch in this fixture"); } }), {
    async describeRuntime() {
      runtimeCalls++;
      return describeCachedDeliveryRuntime({ id: migration.runtime.worker_version_id }, { purge: async () => ({ success: true, errors: [] }) });
    },
    async invalidate() { purgeCalls++; },
  });
  const env = { CASTLOOP_BUCKET: bucket, CASTLOOP_DLQ_NAME: "test-dlq", CASTLOOP_ADMIN_KEY: "mock-only",
    CASTLOOP_VERSION_METADATA: { id: migration.runtime.worker_version_id, tag: "", timestamp: "2026-10-01T12:00:00Z" },
    CASTLOOP_QUEUE: { send: async () => { throw new Error("No publication requeue expected"); } } };
  const batch = (queue = "test-queue") => ({ queue, messages: [{ id: "offline-message-1", timestamp: new Date(), attempts: 1, body: { object: { key: fixture.key } } }] });
  let error: unknown;
  try { await queueM6Candidate(batch(), env, cache); } catch (caught) { error = caught; }
  const primaryCalls = calls.slice();
  const primaryRuntimeCalls = runtimeCalls;
  const primaryPurgeCalls = purgeCalls;
  enabled = false;
  async function state() {
    const control = (await readShowControl(env, "daily"))!.value;
    const service = (await readServiceAdmission(env, "service"))!.value;
    return { status: parseJobStatus(fixture.text(fixture.statusKey)).state,
      status_phase: parseJobStatus(fixture.text(fixture.statusKey)).phase,
      progress_phase: parseLifecycleProgress(fixture.text(fixture.progressKey)).phase,
      lifecycle: control.lifecycle, owner_present: !!control.owner, execution_present: !!control.owner?.execution_id,
      service_invocations: service.invocations.length,
      published_metadata_present: fixture.entries.has("system/shows/daily/show.toml"),
      feed_present: fixture.entries.has(fixture.feedKey) };
  }
  const primary = await state();
  let retryError: unknown;
  if (fault === "none") {
    assert(!error);
    assert.equal(primary.status, "published");
    assert(!primary.owner_present);
    assert.equal(primary.service_invocations, 0);
  } else {
    assert(error instanceof Error);
    assert(!primary.published_metadata_present && !primary.feed_present);
    assert.equal(primary.progress_phase, "feed");
    if (fault === "one-read-failure") {
      assert.equal(primary.status, "retrying");
      assert(!primary.execution_present);
      assert.equal(primary.service_invocations, 0);
      await queueM6Candidate(batch(), env, cache);
      assert.equal((await state()).status, "published");
    } else {
      assert.equal(primary.status, "processing");
      assert.equal(primary.status_phase, "validating");
      assert(primary.execution_present);
      assert.equal(primary.service_invocations, 1);
      try { await queueM6Candidate(batch(), env, cache); } catch (caught) { retryError = caught; }
      assert(retryError instanceof Error && retryError.message.includes("still owns"));
      assert.deepEqual(await state(), primary);
      await queueM6Candidate(batch("test-dlq"), env, cache);
      assert(fixture.entries.has(`system/jobs/${fixture.operation.jobId}/dlq.json`));
      assert.deepEqual(await state(), primary);
    }
  }
  const counts = Object.fromEntries(["get", "head", "put", "list", "delete"].map(method => [method, primaryCalls.filter(row => row.method === method).length]));
  writeFileSync(join(directory, `${fault}-calls.json`), JSON.stringify(primaryCalls, null, 2) + "\n", { mode: 0o600 });
  return { fault, passed: true, primary, after_retry: await state(), error_class: error instanceof Error ? error.name : null,
    retry_error_class: retryError instanceof Error ? retryError.name : null,
    primary_r2_calls: primaryCalls.length, primary_r2_by_method: counts,
    calls_through_feed_progress: primaryCalls.filter(row => row.phase === "before-feed").length,
    runtime_calls: primaryRuntimeCalls, purge_calls: primaryPurgeCalls,
    dlq_marker_present: fixture.entries.has(`system/jobs/${fixture.operation.jobId}/dlq.json`) };
}

try {
  const cases = [];
  for (const fault of ["none", "one-read-failure", "persistent-io-failure"] as const) cases.push(await run(fault));
  assert.equal(networkCalls, 0);
  const summary = { source_commit: label, cases, network_calls: networkCalls, mock_only: true,
    limitation: "Injected persistent IO failures demonstrate token-retention mechanics, not the original live invocation failure cause. Mock counts are not production performance timings." };
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(directory, "worker-logs.json"), JSON.stringify(workerLogs, null, 2) + "\n", { mode: 0o600 });
  console.log = originalLog;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  console.log = originalLog;
}
