import { afterEach, expect, test } from "bun:test";
import { directPublicationFixture } from "./test-support/direct-publication";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";
import { sqliteScheduleTimeSchema } from "../packages/shared/src/sqlite-schedule";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function time(at: number) {
  const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  return sqliteScheduleTimeSchema.parse({ input: iso, scheduled_at: iso, scheduled_at_ms: at, input_offset: "+00:00",
    resolution_source: "offset", timezone: "UTC", timezone_source: "server", local_datetime: iso.slice(0, -1), offset: "+00:00" });
}
async function setup() {
  const f = await directPublicationFixture(); cleanups.push(f.close);
  let now = 1000;
  const schedules = new SqlitePublicationSchedules(f.storage, f.queue, f.content, () => now, { showId: "daily", ready: () => true });
  const input = { schema_version: 1 as const, protocol: "sqlite-schedule-v1" as const, ...f.identity, show_id: "daily",
    schedule_id: crypto.randomUUID(), expected_version: 0 as const, preview_sha256: "c".repeat(64), scheduled_at: time(2000), publication: f.show() };
  const mutation = { schema_version: 1 as const, protocol: "sqlite-schedule-v1" as const, ...f.identity, show_id: "daily", schedule_id: input.schedule_id };
  return { ...f, schedules, input, mutation, setNow: (value: number) => { now = value; } };
}

test("create/list/status freeze inline content without creating a publication job", async () => {
  const f = await setup(), created = await f.schedules.create(f.input);
  expect(created.schedule).toMatchObject({ state: "scheduled", version: 1, revision_id: null });
  expect(created.publication).toEqual(f.input.publication); expect(f.alarm()).toBe(2000);
  expect(f.schedules.list().schedules).toHaveLength(1);
  expect((await f.schedules.create(f.input)).schedule.version).toBe(1);
  expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
});

test("Alarm dispatch commits publication and schedule once, including redelivery", async () => {
  const f = await setup(); await f.schedules.create(f.input);
  expect(await f.schedules.dispatchDue()).toBe(0);
  f.setNow(2000); expect(await f.schedules.dispatchDue()).toBe(1);
  const done = f.schedules.status(f.input.schedule_id).schedule;
  expect(done).toMatchObject({ state: "dispatched", version: 2, dispatched_at_ms: 2000 });
  expect(done.revision_id).toBe(f.content.currentShowRevision("daily", f.config.public_base_url)!.revision_id);
  const count = f.purges.length;
  expect(await f.schedules.dispatchDue()).toBe(0); expect(f.purges).toHaveLength(count);
});

test("one undispatched schedule per target is enforced", async () => {
  const f = await setup(); await f.schedules.create(f.input);
  await expect(f.schedules.create({ ...f.input, schedule_id: crypto.randomUUID() })).rejects.toThrow("open publication schedule");
});

test("a domain change suspends schedules and they need explicit reapproval", async () => {
  const f = await setup(); await f.schedules.create(f.input);
  f.schedules.suspendOpen("domain_change");
  expect(f.schedules.status(f.input.schedule_id).schedule).toMatchObject({ state: "needs_approval", reason_code: "domain_change" });
  f.setNow(2000);
  expect(await f.schedules.dispatchDue()).toBe(0);
});

test("reschedule, reapprove and cancel require the exact current version", async () => {
  const f = await setup(); await f.schedules.create(f.input);
  await f.schedules.reschedule({ ...f.mutation, expected_version: 1, preview_sha256: "d".repeat(64), scheduled_at: time(3000) });
  f.schedules.suspendOpen("domain_change");
  const needs = f.schedules.status(f.input.schedule_id).schedule;
  const reapproved = await f.schedules.reapprove({ ...f.mutation, expected_version: needs.version, preview_sha256: "e".repeat(64), scheduled_at: time(4000), publication: f.show() });
  expect(reapproved.schedule.state).toBe("scheduled");
  const cancel = { ...f.mutation, expected_version: reapproved.schedule.version, preview_sha256: "f".repeat(64) };
  expect((await f.schedules.cancel(cancel)).schedule.state).toBe("cancelled");
  expect((await f.schedules.cancel(cancel)).schedule.state).toBe("cancelled");
  await expect(f.schedules.cancel({ ...cancel, preview_sha256: "0".repeat(64) })).rejects.toThrow();
});

test("changed bases require reapproval before Alarm dispatch", async () => {
  const f = await setup(); await f.schedules.create(f.input); await f.publish(f.show()); f.setNow(2000);
  expect(await f.schedules.dispatchDue()).toBe(0);
  expect(f.schedules.status(f.input.schedule_id).schedule).toMatchObject({ state: "needs_approval", reason_code: "base_conflict" });
});

test("purge and SQLite failures leave the schedule undispatched and content unchanged", async () => {
  for (const failure of ["purge", "database"]) {
    const f = await setup(); await f.schedules.create(f.input); f.setNow(2000);
    if (failure === "purge") f.hooks.purge = async () => { throw new Error("Injected purge failure"); };
    else f.database.exec("CREATE TRIGGER fail_dispatch BEFORE UPDATE OF state ON publication_schedules WHEN NEW.state = 'dispatched' BEGIN SELECT RAISE(ABORT, 'injected dispatch failure'); END");
    await expect(f.schedules.dispatchDue()).rejects.toThrow();
    expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
    expect(f.schedules.status(f.input.schedule_id).schedule).toMatchObject({ state: "scheduled", revision_id: null });
  }
});

test("cancellation during purge rolls back publication instead of reviving a cancelled schedule", async () => {
  const f = await setup(); await f.schedules.create(f.input); f.setNow(2000);
  f.hooks.purge = async () => { await f.schedules.cancel({ ...f.mutation, expected_version: 1, preview_sha256: "d".repeat(64) }); };
  expect(await f.schedules.dispatchDue()).toBe(0);
  expect(f.schedules.status(f.input.schedule_id).schedule.state).toBe("cancelled");
  expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
});

test("next Alarm is scheduled for the earliest pending schedule", async () => {
  const f = await setup(); await f.schedules.create(f.input); f.clearAlarm();
  await f.schedules.scheduleNext(); expect(f.alarm()).toBe(2000);
});
