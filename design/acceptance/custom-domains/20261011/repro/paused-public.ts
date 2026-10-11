import { migrationFixture } from "../../../../../src/test-support/migration";
import { runLifecycleMigrationStep } from "../../../../../src/lifecycle-migration-apply";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "../../../../../src/service-admission";
import { fetchM6Candidate } from "../../../../../src/m6-routes";
import { describeCachedDeliveryRuntime } from "../../../../../src/lifecycle-delivery-gate";

const setup = await migrationFixture();
for (let index = 0; index < 3; index++) {
  await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
}
const admission = await readServiceAdmission(setup.env, "service");
if (!admission) throw new Error("Missing test admission");
await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...admission.value,
  state: "paused", pause_id: crypto.randomUUID(), invocations: [] }));
let cacheCalls = 0;
const loopback = Object.assign(() => ({ fetch: async () => {
  cacheCalls++;
  return new Response("local fake cached bytes", { status: 200 });
} }), {
  invalidate: async () => {},
  describeRuntime: async () => describeCachedDeliveryRuntime({ id: setup.runtime.worker_version_id },
    { purge: async () => ({ success: true, errors: [] }) }),
});
const env = { CASTLOOP_BUCKET: setup.bucket, CASTLOOP_DLQ_NAME: "test-dlq", CASTLOOP_ADMIN_KEY: "private-secret",
  CASTLOOP_VERSION_METADATA: { id: setup.runtime.worker_version_id, tag: "", timestamp: "2026-10-01T12:00:00Z" },
  CASTLOOP_QUEUE: { send: async () => {} } };
const response = await fetchM6Candidate(new Request("https://current.example/podcasts/daily/feed.xml"), env as never, loopback);
console.log(JSON.stringify({ local_only: true, cloudflare_requests: 0, admission_state: "paused", invocations: [],
  expected_status: 503, actual_status: response.status, cache_calls: cacheCalls }, null, 2));
