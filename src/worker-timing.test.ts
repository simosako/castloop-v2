import { describe, expect, spyOn, test } from "bun:test";
import { logPublicationDelivery, measureWorkerPhase } from "./worker-timing";

describe("Worker phase timing", () => {
  test("logs only timing identity and preserves results and exceptions", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const jobId = crypto.randomUUID();
    const secret = new Error("secret exception detail");
    try {
      expect(await measureWorkerPhase(jobId, "publication.guard", async () => 42)).toBe(42);
      await expect(measureWorkerPhase(jobId, "publication.audio", async () => { throw secret; })).rejects.toBe(secret);
      const records = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records.map((record) => record.outcome)).toEqual(["success", "error"]);
      for (const record of records) {
        expect(Object.keys(record).sort()).toEqual(["duration_ms", "event", "finished_at", "job_id", "outcome", "phase", "started_at"]);
        expect(record.job_id).toBe(jobId);
        expect(record.duration_ms).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(Date.parse(record.started_at))).toBe(true);
        expect(Number.isFinite(Date.parse(record.finished_at))).toBe(true);
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret.message);
    } finally { log.mockRestore(); }
  });

  test("nested and concurrent measurements have independent timestamps", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await measureWorkerPhase(crypto.randomUUID(), "publication.consumer", () => Promise.all([
        measureWorkerPhase(crypto.randomUUID(), "publication.feed_inputs", async () => { await Bun.sleep(1); }),
        measureWorkerPhase(crypto.randomUUID(), "publication.unique_guid", async () => {}),
      ]));
      expect(log.mock.calls).toHaveLength(3);
      logPublicationDelivery(crypto.randomUUID(), new Date("2026-10-12T06:00:00Z"), 1);
      expect(JSON.parse(String(log.mock.calls[3]![0]))).toMatchObject({ event: "publication_delivery",
        message_timestamp: "2026-10-12T06:00:00.000Z", attempts: 1 });
    } finally { log.mockRestore(); }
  });

  test("missing delivery metadata and logging failure do not interrupt operations", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      logPublicationDelivery(crypto.randomUUID(), undefined, undefined);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ message_timestamp: null, attempts: null });
      log.mockImplementation(() => { throw new Error("logger unavailable"); });
      expect(await measureWorkerPhase(crypto.randomUUID(), "publication.commit", async () => 42)).toBe(42);
      const error = new Error("original error");
      await expect(measureWorkerPhase(crypto.randomUUID(), "publication.commit", async () => { throw error; })).rejects.toBe(error);
    } finally { log.mockRestore(); }
  });
});
