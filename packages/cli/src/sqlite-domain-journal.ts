import { z } from "zod";
import { requireSqliteDomainConnection, sqliteDomainActivationSchema, sqliteDomainConnectionSchema, sqliteDomainRequestSchema } from "../../shared/src/sqlite-domain";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteScriptUploadReceiptSchema } from "./sqlite-cloudflare";
import { createLocalJournalStorage } from "./local-journal-storage";

const deployment = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
export const sqliteDomainJournalSchema = z.object({ schema_version: z.literal(1), request: sqliteDomainRequestSchema,
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/), previous: deployment.extend({ namespace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
  phase: z.enum(["prepared", "prepare_requested", "maintenance", "connection_requested", "connected", "config_requested", "configured",
    "deploy_requested", "deploy_acknowledged", "deployed", "verified", "activation_requested", "probing", "remote_ready", "local_synced",
    "detach_requested", "detached", "finalize_requested", "completed"]),
  connection: sqliteDomainConnectionSchema.optional(), upload_receipt: sqliteScriptUploadReceiptSchema.optional(),
  receipt: deployment.optional(), activation: sqliteDomainActivationSchema.optional(),
  detach_acknowledged: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  const phases = ["prepared", "prepare_requested", "maintenance", "connection_requested", "connected", "config_requested", "configured",
    "deploy_requested", "deploy_acknowledged", "deployed", "verified", "activation_requested", "probing", "remote_ready", "local_synced",
    "detach_requested", "detached", "finalize_requested", "completed"];
  const at = (phase: string) => phases.indexOf(value.phase) >= phases.indexOf(phase);
  if (value.connection) {
    try { requireSqliteDomainConnection(value.connection, value.request); }
    catch { context.addIssue({ code: "custom", message: "Domain journal connection differs from its frozen target" }); }
  }
  if (at("connected") !== !!value.connection || at("deploy_acknowledged") !== !!value.upload_receipt ||
    at("deployed") !== !!value.receipt || at("activation_requested") !== !!value.activation ||
    value.previous.worker_version_id !== value.request.previous_runtime.worker_version_id || value.previous.namespace_id !== value.request.namespace_id ||
    value.receipt && (value.receipt.script_etag !== value.upload_receipt?.script_etag || value.receipt.worker_version_id === value.previous.worker_version_id || value.receipt.deployment_id === value.previous.deployment_id) ||
    value.activation && (value.activation.operation_id !== value.request.operation_id || value.activation.request_sha256 !== value.request_sha256 ||
      value.activation.worker_version_id !== value.receipt?.worker_version_id || value.activation.deployment_id !== value.receipt?.deployment_id ||
      value.activation.script_etag !== value.receipt?.script_etag || JSON.stringify(value.activation.connection) !== JSON.stringify(value.connection)) ||
    (value.request.action === "remove" && at("detached")) !== (value.detach_acknowledged === true) ||
    value.request.action === "add" && ["detach_requested", "detached"].includes(value.phase)) {
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
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
