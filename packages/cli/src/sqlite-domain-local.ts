import { z } from "zod";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { ensureLocalJournalParents } from "./local-journal-path";
import { readSqliteDomainJournal } from "./sqlite-domain-journal";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function pendingLocalDomainChanges(root: string, config: SqliteServiceConfig) {
  ensureLocalJournalParents(root, "sqlite-domain-changes", config.service_id);
  let names: string[];
  try { names = readdirSync(join(root, ".castloop", "sqlite-domain-changes", config.service_id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (names.length > 20000) throw new Error("Domain journal inventory exceeds its budget");
  const ids = names.filter((name) => name.endsWith(".json")).map((name) => z.uuid().parse(name.slice(0, -5)));
  const pending = [];
  for (const operationId of [...ids].sort()) {
    const record = readSqliteDomainJournal(root, config, operationId);
    if (record && (record.request.operation_id !== operationId || record.request.previous_config.service_id !== config.service_id)) throw new Error("Local domain operation identity differs");
    if (!record || record.phase !== "completed") pending.push({ operation_id: operationId, phase: record?.phase ?? null, lock_present: false });
  }
  return pending;
}
