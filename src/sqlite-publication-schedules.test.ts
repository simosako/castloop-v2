import { afterEach, describe, expect, test } from "bun:test";
import { sqlitePublicationRequest, sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";
import { sqliteScheduleTimeSchema } from "../packages/shared/src/sqlite-schedule";
import type { SqliteScheduleCreate } from "../packages/shared/src/sqlite-schedule";

const fixtures: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

function time(at: number) {
  const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  return sqliteScheduleTimeSchema.parse({ input: iso, scheduled_at: iso, scheduled_at_ms: at, input_offset: "+00:00",
    resolution_source: "offset", timezone: "UTC", timezone_source: "server", local_datetime: iso.slice(0, -1), offset: "+00:00" });
}

function setup(options: { now?: number } = {}) {
  const value = sqlitePublicationFixture();
  fixtures.push(value);
  const content = new SqlitePublicationContent(value.storage);
  content.registerShow("daily", crypto.randomUUID());
  let now = options.now ?? 1000;
  const schedules = new SqlitePublicationSchedules(value.storage, value.queue, content, () => now,
    { showId: "daily", ready: () => true });
  return { ...value, content, schedules, setNow: (next: number) => { now = next; } };
}

function createInput(value: ReturnType<typeof setup>, overrides: Partial<SqliteScheduleCreate> = {}, publication = value.request({ kind: "show" })): SqliteScheduleCreate {
  return {
    schema_version: 1, protocol: "sqlite-schedule-v1", service_id: value.runtime.service_id,
    worker_version_id: value.runtime.worker_version_id, service_config_sha256: value.runtime.service_config_sha256,
    show_id: "daily", schedule_id: crypto.randomUUID(), expected_version: 0, preview_sha256: "c".repeat(64),
    scheduled_at: time(2000), publication, ...overrides,
  };
}

describe("SQLite publication schedules", () => {
  test("create, list and status retain a future frozen publication without a FIFO job", async () => {
    const value = setup();
    const input = createInput(value);
    const created = await value.schedules.create(input);
    expect(created.schedule).toMatchObject({ state: "scheduled", version: 1, scheduled_at: { scheduled_at_ms: 2000 },
      job_id: input.publication.job_id, publication_state: null });
    expect(value.queue.snapshot().queued).toBe(0);
    expect(value.alarm()).toBe(2000);
    expect(value.schedules.status(input.schedule_id).schedule.schedule_id).toBe(input.schedule_id);
    const list = value.schedules.list();
    expect(list.schedules).toHaveLength(1);
    expect(list.next_cursor).toBeNull();
    expect((await value.schedules.create(input)).schedule.version).toBe(1);
  });

  test("dispatch due schedules once and preserve the publication job as separate state", async () => {
    const value = setup();
    const input = createInput(value);
    await value.schedules.create(input);
    value.setNow(2000);
    expect(await value.schedules.dispatchDue()).toBe(1);
    expect(value.queue.snapshot().queued).toBe(0);
    expect(value.schedules.status(input.schedule_id).schedule).toMatchObject({ state: "dispatched", version: 2,
      publication_state: "succeeded" });
    expect(await value.schedules.dispatchDue()).toBe(0);
    expect(value.queue.snapshot().queued).toBe(0);
  });

  test("pause and maintenance suspend open schedules for explicit reapproval", async () => {
    const value = setup();
    const input = createInput(value);
    await value.schedules.create(input);
    value.schedules.suspendOpen("show_paused");
    expect(value.schedules.status(input.schedule_id).schedule).toMatchObject({ state: "needs_approval", version: 2,
      reason_code: "show_paused" });
    value.setNow(2000);
    expect(await value.schedules.dispatchDue()).toBe(0);
    expect(value.queue.snapshot().queued).toBe(0);
  });

  test("a Show pause suspends schedules in the same control transaction and resume does not reactivate them", async () => {
    const value = setup();
    const input = createInput(value);
    await value.schedules.create(input);
    const control = { service_id: value.runtime.service_id, worker_version_id: value.runtime.worker_version_id,
      service_config_sha256: value.runtime.service_config_sha256, operation_id: crypto.randomUUID(), action: "pause" as const,
      show_id: "daily", expected_availability_version: 0 };
    await value.queue.applyControl(control, value.runtime, (reason) => value.schedules.suspendOpen(reason));
    expect(value.queue.snapshot().state).toBe("paused");
    expect(value.schedules.status(input.schedule_id).schedule).toMatchObject({ state: "needs_approval", reason_code: "show_paused" });
    const window = crypto.randomUUID();
    value.queue.resume(window);
    expect(value.queue.snapshot().state).toBe("open");
    expect(value.schedules.status(input.schedule_id).schedule.state).toBe("needs_approval");
  });

  test("reschedule, cancel and reapprove use the expected version", async () => {
    const value = setup();
    const input = createInput(value);
    const created = await value.schedules.create(input);
    const mutation = { schema_version: 1 as const, protocol: "sqlite-schedule-v1" as const, service_id: value.runtime.service_id,
      worker_version_id: value.runtime.worker_version_id, service_config_sha256: value.runtime.service_config_sha256,
      show_id: "daily", schedule_id: input.schedule_id };
    const rescheduled = await value.schedules.reschedule({ ...mutation, expected_version: created.schedule.version,
      preview_sha256: "d".repeat(64), scheduled_at: time(3000) });
    expect(rescheduled.schedule).toMatchObject({ state: "scheduled", version: 2, scheduled_at: { scheduled_at_ms: 3000 } });
    value.schedules.suspendOpen("maintenance");
    const needs = value.schedules.status(input.schedule_id).schedule;
    expect(needs.state).toBe("needs_approval");
    const publication = value.request({ kind: "show", job_id: input.publication.job_id });
    const reapproved = await value.schedules.reapprove({ ...mutation, expected_version: needs.version,
      preview_sha256: "e".repeat(64), scheduled_at: time(4000), publication });
    expect(reapproved.schedule).toMatchObject({ state: "scheduled", version: needs.version + 1,
      scheduled_at: { scheduled_at_ms: 4000 } });
    const cancelled = await value.schedules.cancel({ ...mutation, expected_version: reapproved.schedule.version,
      preview_sha256: "f".repeat(64) });
    expect(cancelled.schedule).toMatchObject({ state: "cancelled", version: reapproved.schedule.version + 1,
      reason_code: "cancelled_by_administrator" });
    await expect(value.schedules.cancel({ ...mutation, expected_version: reapproved.schedule.version,
      preview_sha256: "0".repeat(64) })).rejects.toThrow();
    expect((await value.schedules.cancel({ ...mutation, expected_version: reapproved.schedule.version,
      preview_sha256: "f".repeat(64) })).schedule.state).toBe("cancelled");
  });

  test("transient executor failure rolls back dispatch and leaves no job", async () => {
    const value = setup();
    const input = createInput(value);
    await value.schedules.create(input);
    value.setNow(2000);
    value.queue.executor = { execute: async () => { throw new Error("transient failure"); } };
    await expect(value.schedules.dispatchDue()).rejects.toThrow("transient failure");
    expect(value.schedules.status(input.schedule_id).schedule.state).toBe("scheduled");
    expect(value.queue.snapshot().queued).toBe(0);
  });

  test("a changed target base stops dispatch for reapproval instead of entering the FIFO", async () => {
    const value = setup();
    const input = createInput(value);
    await value.schedules.create(input);
    value.database.exec("UPDATE publication_shows SET state_version = 1 WHERE show_id = 'daily'");
    value.setNow(2000);
    expect(await value.schedules.dispatchDue()).toBe(0);
    expect(value.schedules.status(input.schedule_id).schedule).toMatchObject({ state: "needs_approval",
      reason_code: "base_conflict" });
    expect(value.queue.snapshot().queued).toBe(0);
  });

  test("the next schedule reserve is set when admission is open and skipped when paused", async () => {
    const value = setup();
    await value.schedules.create(createInput(value));
    value.clearAlarm();
    await value.schedules.scheduleNext();
    expect(value.alarm()).toBe(2000);
    value.queue.pause();
    value.clearAlarm();
    await value.schedules.scheduleNext();
    expect(value.alarm()).toBeNull();
  });
});
