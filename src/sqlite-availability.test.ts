import { afterEach, expect, test } from "bun:test";
import { sqliteAvailabilityRequestSchema } from "../packages/shared/src/sqlite-availability";
import type { SqliteAvailabilityRequest } from "../packages/shared/src/sqlite-availability";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";

const fixtures: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });
function fixture() {
  const value = sqlitePublicationFixture({ resume: false }); fixtures.push(value);
  let ready = true;
  const queue = new SqlitePublicationQueue(value.storage, value.runtime, () => 1000, { showId: "daily", ready: () => ready });
  const request = (action: SqliteAvailabilityRequest["action"], overrides: Partial<SqliteAvailabilityRequest> = {}) =>
    sqliteAvailabilityRequestSchema.parse({ ...value.runtime, show_id: "daily", operation_id: crypto.randomUUID(), action,
      expected_availability_version: queue.snapshot().availability_version,
      ...(action === "resume" ? { admission_window_id: crypto.randomUUID() } : {}), ...overrides });
  return { ...value, queue, request, publication: value.request, setReady: (next: boolean) => { ready = next; } };
}

test("controls preserve three states, immutable results, explicit windows and repeated stop observations", async () => {
  const value = fixture(), queue = value.queue;
  const first = await queue.applyControl(value.request("resume"));
  expect(first.result).toMatchObject({ state: "open", availability_version: 1 });
  await queue.applyControl(value.request("admission-pause"));
  expect(queue.snapshot()).toMatchObject({ state: "admission_paused", admission_window_id: first.result.admission_window_id });
  const stop = value.request("pause"); await queue.applyControl(stop);
  const staleResume = value.request("delivery-resume");
  await queue.applyControl(value.request("pause"));
  await expect(queue.applyControl(staleResume)).rejects.toThrow("stale");
  expect(queue.snapshot().availability_version).toBe(4);
  expect(await queue.applyControl(stop)).toEqual(queue.controlRecord(stop.operation_id)!);
  expect(queue.snapshot().availability_version).toBe(4);
  await queue.applyControl(value.request("admission-pause"));
  expect(queue.snapshot().state).toBe("paused");
  await queue.applyControl(value.request("delivery-resume"));
  expect(queue.snapshot()).toMatchObject({ state: "admission_paused", admission_window_id: first.result.admission_window_id });
  await queue.applyControl(value.request("resume"));
  expect(queue.snapshot().state).toBe("open");
  await expect(queue.applyControl(value.request("delivery-resume"))).rejects.toThrow();
  await expect(queue.applyControl({ ...stop, action: "admission-pause" })).rejects.toThrow("frozen");
});

test("stopped admission drains accepted FIFO without changing its window and both resumes wait for completion", async () => {
  const value = fixture(); const opened = await value.queue.applyControl(value.request("resume"));
  const window = opened.result.admission_window_id!;
  const publication = value.publication({ admission_window_id: window });
  await value.queue.enqueue(publication);
  await value.queue.applyControl(value.request("admission-pause"));
  await expect(value.queue.enqueue(value.publication({ admission_window_id: window, episode_id: "second" }))).rejects.toThrow("paused");
  await expect(value.queue.applyControl(value.request("resume"))).rejects.toThrow("drained");
  const claim = value.queue.claim(); expect(claim.state).toBe("claimed");
  await value.queue.applyControl(value.request("pause"));
  await expect(value.queue.applyControl(value.request("delivery-resume"))).rejects.toThrow("drained");
  await value.queue.finish(publication.job_id, "validation_failed");
  await value.queue.applyControl(value.request("delivery-resume"));
  expect(value.queue.snapshot()).toMatchObject({ state: "admission_paused", drained: true, admission_window_id: window });
});

test("blocked work and unverified runtimes cannot resume, while explicit pause remains available", async () => {
  const value = fixture(); const opened = await value.queue.applyControl(value.request("resume"));
  const publication = value.publication({ admission_window_id: opened.result.admission_window_id! });
  await value.queue.enqueue(publication); value.queue.claim();
  await value.queue.block(publication.job_id, "execution_interrupted");
  await value.queue.applyControl(value.request("pause"));
  await expect(value.queue.applyControl(value.request("resume"))).rejects.toThrow("drained");
  await expect(value.queue.applyControl(value.request("delivery-resume"))).rejects.toThrow("drained");
  value.setReady(false);
  await expect(value.queue.applyControl(value.request("delivery-resume"))).rejects.toThrow("verified");
  const before = value.queue.snapshot().availability_version;
  await value.queue.applyControl(value.request("pause"));
  expect(value.queue.snapshot().availability_version).toBe(before + 1);
});

test("runtime, config, Show and old window mismatches do not write control results", async () => {
  const value = fixture(); const first = await value.queue.applyControl(value.request("resume"));
  for (const overrides of [{ worker_version_id: crypto.randomUUID() }, { service_config_sha256: "b".repeat(64) }, { show_id: "other" }, { service_id: "other" }]) {
    const request = value.request("pause", overrides);
    await expect(value.queue.applyControl(request)).rejects.toThrow("target");
    expect(value.queue.controlRecord(request.operation_id)).toBeNull();
  }
  await value.queue.applyControl(value.request("pause"));
  await value.queue.applyControl(value.request("resume"));
  await value.queue.applyControl(value.request("pause"));
  const current = value.queue.snapshot();
  const reused = value.request("resume", { admission_window_id: first.result.admission_window_id! });
  await expect(value.queue.applyControl(reused)).rejects.toThrow();
  expect(value.queue.snapshot()).toEqual(current); expect(value.queue.controlRecord(reused.operation_id)).toBeNull();
});

test("a failing state write rolls back its control result and version together", async () => {
  const value = fixture(), request = value.request("resume"), before = value.queue.snapshot();
  value.storage.sql.exec("CREATE TRIGGER fail_control BEFORE UPDATE ON publication_service BEGIN SELECT RAISE(ABORT, 'Injected control write failure'); END");
  await expect(value.queue.applyControl(request)).rejects.toThrow("Injected control");
  expect(value.queue.snapshot()).toEqual(before); expect(value.queue.controlRecord(request.operation_id)).toBeNull();
});

test("unconfirmed durability preserves server results across reconstruction without replay", async () => {
  const value = fixture(), request = value.request("resume"); value.failSync();
  await expect(value.queue.applyControl(request)).rejects.toThrow("durability");
  const next = new SqlitePublicationQueue(value.storage, value.runtime);
  expect(next.controlRecord(request.operation_id)?.result).toMatchObject({ state: "open", availability_version: 1 });
  expect(next.snapshot().availability_version).toBe(1);
  const stopped = value.request("pause"); await value.queue.applyControl(stopped);
  expect(next.controlRecord(request.operation_id)?.result.state).toBe("open");
  expect(next.snapshot().state).toBe("paused");
});
