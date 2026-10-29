import { z } from "zod";
import { requireSqliteDomainConnection, sqliteDomainConnectionSchema, sqliteDomainRequestSchema } from "../../shared/src/sqlite-domain";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { createLocalJournalStorage } from "./local-journal-storage";

const deployment = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
export const sqliteDomainJournalSchema = z.object({ schema_version: z.literal(1), request: sqliteDomainRequestSchema,
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/), previous: deployment.extend({ namespace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
  phase: z.enum(["prepared", "connected", "deployed", "remote_ready", "local_synced", "completed"]),
  connection: sqliteDomainConnectionSchema.optional(),
  receipt: deployment.optional(),
}).strict().superRefine((value, context) => {
  const phases = ["prepared", "connected", "deployed", "remote_ready", "local_synced", "completed"];
  const at = (phase: string) => phases.indexOf(value.phase) >= phases.indexOf(phase);
  if (value.connection) {
    try { requireSqliteDomainConnection(value.connection, value.request); }
    catch { context.addIssue({ code: "custom", message: "Domain journal connection differs from its frozen target" }); }
  }
  if (at("connected") !== !!value.connection || at("deployed") !== !!value.receipt ||
    value.previous.namespace_id !== value.request.namespace_id ||
    value.receipt && (value.receipt.worker_version_id === value.previous.worker_version_id || value.receipt.deployment_id === value.previous.deployment_id)) {
    context.addIssue({ code: "custom", message: "Domain journal phase and acknowledged evidence differ" });
  }
});
export type SqliteDomainJournal = z.infer<typeof sqliteDomainJournalSchema>;
export function sqliteDomainJournal(root: string, config: SqliteServiceConfig, operationId: string) {
  z.uuid().parse(operationId);
  return createLocalJournalStorage(root, "sqlite-domain-changes", config.service_id, `${operationId}.json`);
}
export function readSqliteDomainJournal(root: string, config: SqliteServiceConfig, operationId: string): SqliteDomainJournal | null {
  try { return sqliteDomainJournalSchema.parse(sqliteDomainJournal(root, config, operationId).read()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; }
}
