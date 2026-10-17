import { expect, test } from "bun:test";
import { z } from "zod";
import { createLocalJournalStorage } from "./local-journal-storage";
import { bindLocalJournal } from "./validated-local-journal";
import { mkdtempSync, rmSync } from "node:fs";

test("validated journals require the lock before parsing and revalidate retained identity before each write", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-validated-journal-");
  try {
    const schema = z.object({ operation_id: z.string(), step: z.number().int().nonnegative() }).strict();
    const storage = createLocalJournalStorage(root, "service-initializations", undefined, "operation.json");
    const initial = { operation_id: "one", step: 0 };
    storage.initialize(initial);
    const journal = bindLocalJournal(storage, {
      parse: (value) => schema.parse(value),
      assertIdentity: (state) => { if (state.operation_id !== initial.operation_id) throw new Error("Frozen identity differs"); },
      assertTransition: (previous, next) => {
        if (next.operation_id !== previous.operation_id || next.step - previous.step !== 1) throw new Error("Invalid transition");
      },
      lockMessage: "Expected client lock",
    });
    expect(() => journal.save({ ...initial, step: -1 })).toThrow("Expected client lock");
    await journal.exclusively(async () => {
      expect(() => journal.save({ ...initial, step: 2 })).toThrow("Invalid transition");
      expect(() => journal.save({ ...initial, step: -1 })).toThrow();
      expect(storage.read()).toEqual(initial);
      journal.save({ ...initial, step: 1 });
      expect(journal.load()).toEqual({ ...initial, step: 1 });
      storage.replace({ operation_id: "other", step: 1 });
      expect(() => journal.load()).toThrow("Frozen identity differs");
      expect(() => journal.save({ ...initial, step: 2 })).toThrow("Frozen identity differs");
      expect(storage.read()).toEqual({ operation_id: "other", step: 1 });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
