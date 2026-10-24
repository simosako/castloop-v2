import { z } from "zod";
import { sqliteAvailabilityRequestSchema } from "../../shared/src/sqlite-availability";
import { sqliteAvailabilityResponseSchema } from "../../shared/src/sqlite-service-api";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { ensureLocalJournalParents } from "./local-journal-path";
import { readBoundedLocalJournal } from "./local-journal-read";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const sqliteControlJournalSchema = z.object({ schema_version: z.literal(2), request: sqliteAvailabilityRequestSchema,
  phase: z.enum(["prepared", "requested", "confirmed"]), result: sqliteAvailabilityResponseSchema.optional() }).strict().superRefine((value, context) => {
  if ((value.phase === "confirmed") !== (value.result !== undefined) ||
    value.result && JSON.stringify(value.result.control.request) !== JSON.stringify(value.request)) {
    context.addIssue({ code: "custom", message: "Service control phase and evidence differ" });
  }
});

export function pendingSqliteControls(root: string, config: SqliteServiceConfig): number {
  ensureLocalJournalParents(root, "sqlite-controls", config.service_id);
  const directory = join(root, ".castloop", "sqlite-controls", config.service_id);
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  if (files.length > 40000) throw new Error("Show control inventory exceeds its budget");
  const entries = new Set(files);
  const ids = new Set(files.filter((file) => /\.json(?:\.lock)?$/.test(file)).map((file) => z.uuid().parse(file.replace(/\.json(?:\.lock)?$/, ""))));
  let pending = 0;
  for (const id of ids) {
    if (entries.has(`${id}.json.lock`) || !entries.has(`${id}.json`)) { pending++; continue; }
    const record = sqliteControlJournalSchema.parse(readBoundedLocalJournal(join(directory, `${id}.json`)));
    if (record.request.service_id !== config.service_id || record.request.operation_id !== id) throw new Error("Show control journal target differs");
    if (record.phase !== "confirmed") pending++;
  }
  return pending;
}
