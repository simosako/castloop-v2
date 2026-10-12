import { describe, expect, spyOn, test } from "bun:test";
import { parseShowControl } from "../packages/shared/src/index";
import { acquireShowExecution, createShowExecutionEnv, requireShowExecution } from "./lifecycle-control";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { createPublicationWorkerEffects } from "./lifecycle-worker-effects";
import { consumeOwnedPublication } from "./publication-consumer";
import { runOwnedEpisodePublication } from "./publication-episode-runner";
import { episodePublicationFixture } from "./test-support/episode-publication";

describe("invocation-scoped verified Show execution", () => {
  test("reuses only frozen request and reservation while rereading current ownership", async () => {
    const setup = await episodePublicationFixture();
    const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
    const controlKey = "system/show-publications/daily.json";
    const reservationKey = "system/show-reservations/daily.json";
    const reservationId = crypto.randomUUID();
    const current = parseShowControl(JSON.parse(setup.text(controlKey)));
    await setup.bucket.put(controlKey, JSON.stringify({ ...current, reservation_id: reservationId }));
    await setup.bucket.put(reservationKey, JSON.stringify({ show_id: "daily", reservation_id: reservationId }));
    const get = spyOn(setup.bucket, "get");
    try {
      const env = await createShowExecutionEnv<LifecycleControlEnv>(setup.env, execution);
      const frozenKey = `system/jobs/${execution.jobId}/request.toml`;
      for (let index = 0; index < 5; index++) await requireShowExecution(env, execution);
      expect(get.mock.calls.filter(([key]) => key === frozenKey)).toHaveLength(2);
      expect(get.mock.calls.filter(([key]) => key === reservationKey)).toHaveLength(1);
      expect(get.mock.calls.filter(([key]) => key === controlKey)).toHaveLength(6);
      await expect(createShowExecutionEnv(env, execution)).rejects.toThrow("another invocation");
      const saved = parseShowControl(JSON.parse(setup.text(controlKey)));
      for (const changed of [
        { ...saved, reservation_id: crypto.randomUUID() },
        { ...saved, generation: saved.generation + 1 },
        { ...saved, owner: { ...saved.owner!, execution_id: crypto.randomUUID() } },
        { ...saved, owner: { ...saved.owner!, request_sha256: "a".repeat(64) } },
        { ...saved, owner: { ...saved.owner!, job_id: crypto.randomUUID() } },
      ]) {
        await setup.bucket.put(controlKey, JSON.stringify(changed));
        await expect(requireShowExecution(env, execution)).rejects.toThrow();
      }
      await setup.bucket.put(controlKey, JSON.stringify(saved));
      await expect(requireShowExecution(env, { ...execution, jobId: crypto.randomUUID() })).rejects.toThrow();
      const foreign = { ...env, CASTLOOP_BUCKET: { ...env.CASTLOOP_BUCKET } };
      await expect(requireShowExecution(foreign, execution)).rejects.toThrow("Verified request");
      await createShowExecutionEnv(setup.env, execution);
      expect(get.mock.calls.filter(([key]) => key === frozenKey)).toHaveLength(4);
      expect(get.mock.calls.filter(([key]) => key === reservationKey)).toHaveLength(2);
    } finally { get.mockRestore(); }
  });

  test("missing, changed and oversized frozen inputs cannot establish a verified context", async () => {
    for (const fault of ["missing", "changed", "oversized", "reservation"] as const) {
      const setup = await episodePublicationFixture();
      const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
      const key = `system/jobs/${execution.jobId}/request.toml`;
      if (fault === "reservation") {
        const controlKey = "system/show-publications/daily.json";
        await setup.bucket.put(controlKey, JSON.stringify({ ...JSON.parse(setup.text(controlKey)), reservation_id: crypto.randomUUID() }));
      } else if (fault === "missing") setup.entries.delete(key);
      else await setup.bucket.put(key, fault === "oversized" ? "x".repeat(16385) :
        setup.text(key).replace(setup.operation.jobId, crypto.randomUUID()));
      const before = setup.writes.length;
      await expect(createShowExecutionEnv(setup.env, execution)).rejects.toThrow();
      expect(setup.writes.length).toBe(before);
    }
  });

  test("formal publication factory shares proof with runner and effects without changing outputs", async () => {
    const totals: Array<{ get: number; request: number; reservation: number }> = [];
    for (const optimized of [false, true]) {
      const setup = await episodePublicationFixture("metadata");
      const controlKey = "system/show-publications/daily.json";
      const reservationKey = "system/show-reservations/daily.json";
      const reservationId = crypto.randomUUID();
      await setup.bucket.put(controlKey, JSON.stringify({ ...JSON.parse(setup.text(controlKey)), reservation_id: reservationId }));
      await setup.bucket.put(reservationKey, JSON.stringify({ show_id: "daily", reservation_id: reservationId }));
      const get = spyOn(setup.bucket, "get");
      try {
        const bindings = { async checkDeliveryGate() {}, cachedAssets: { async invalidate() {} } };
        if (optimized) {
          await consumeOwnedPublication(setup.env, setup.key, (execution, env) => createPublicationWorkerEffects(env, execution, bindings));
        } else {
          const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
          await runOwnedEpisodePublication(setup.env, execution, await createPublicationWorkerEffects(setup.env, execution, bindings));
        }
        totals.push({ get: get.mock.calls.length,
          request: get.mock.calls.filter(([key]) => key === `system/jobs/${setup.operation.jobId}/request.toml`).length,
          reservation: get.mock.calls.filter(([key]) => key === reservationKey).length });
        const control = parseShowControl(JSON.parse(setup.text("system/show-publications/daily.json")));
        expect(control.owner).toBeUndefined();
        expect(setup.text(setup.feedKey)).toContain(setup.draft.guid);
        expect(setup.entries.has(setup.mediaKey)).toBe(false);
      } finally { get.mockRestore(); }
    }
    expect(totals[1]!.request).toBe(5);
    expect(totals[1]!.reservation).toBe(2);
    expect(totals[1]!.get).toBeLessThan(totals[0]!.get - 120);
  });
});
