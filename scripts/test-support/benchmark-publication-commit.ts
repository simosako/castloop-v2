import { spyOn } from "bun:test";
import { resolve } from "node:path";

const project = resolve(process.argv[2] ?? ".");
const fixture: typeof import("../../src/test-support/publication-admin") = await import(`${project}/src/test-support/publication-admin.ts`);
const shared: typeof import("../../packages/shared/src/index") = await import(`${project}/packages/shared/src/index.ts`);
const warmup = 30;
const samples = 200;
const rows = [];
const log = console.log;
console.log = () => {};
try {
  for (const mode of ["show", "episode", "metadata", "audio"] as const) {
    const setup = await fixture.publicationAdminFixture(mode);
    await setup.publicationSuccess(setup.body("claim"));
    const controlKey = "system/show-publications/daily.json";
    const reservationKey = "system/show-reservations/daily.json";
    const current = shared.parseShowControl(JSON.parse(await (await setup.env.CASTLOOP_BUCKET.get(controlKey))!.text()));
    const reservationId = crypto.randomUUID();
    await setup.bucket.put(controlKey, JSON.stringify({ ...current, reservation_id: reservationId }));
    await setup.bucket.put(reservationKey, JSON.stringify({ show_id: "daily", reservation_id: reservationId }));
    const commit = async () => {
      setup.entries.delete(setup.markerKey);
      await setup.publicationSuccess(setup.body("commit"));
    };
    for (let index = 0; index < warmup; index++) await commit();
    const times = [];
    const cpu = process.cpuUsage();
    for (let index = 0; index < samples; index++) {
      const start = performance.now();
      await commit();
      times.push(performance.now() - start);
    }
    const elapsed = process.cpuUsage(cpu);
    const get = spyOn(setup.bucket, "get");
    const head = spyOn(setup.bucket, "head");
    const parse = spyOn(shared.stageUploadRequestSchema, "parse");
    try {
      await commit();
      const count = (key: string) => get.mock.calls.filter(([value]) => value === key).length;
      times.sort((left, right) => left - right);
      rows.push({ mode, samples, cpu_ms_per_commit: (elapsed.user + elapsed.system) / 1000 / samples,
        wall_p50_ms: times[Math.floor(samples * 0.5)], wall_p95_ms: times[Math.floor(samples * 0.95)],
        counts: { gets: get.mock.calls.length, heads: head.mock.calls.length, staging_parses: parse.mock.calls.length,
          control_reads: count("system/show-publications/daily.json"), episode_reads: count("system/episode-lifecycle/daily/next.toml"),
          reservation_reads: count(reservationKey),
          frozen_control_reads: count(`system/jobs/${setup.frozen.request.job_id}/request.toml`),
          frozen_manifest_reads: count(`system/jobs/${setup.frozen.request.job_id}/publication.json`) } });
    } finally { get.mockRestore(); head.mockRestore(); parse.mockRestore(); }
  }
} finally { console.log = log; }
console.log(JSON.stringify({ project, runtime: Bun.version, warmup, samples,
  scope: "Local Bun CPU with in-memory R2 and repeated reserved commit; not Workers CPU or real-network latency", rows }, null, 2));
