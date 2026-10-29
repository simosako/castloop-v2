import { z } from "zod";
import { requireSqliteDomainConnection, sqliteDomainCommitSchema, sqliteDomainConnectionSchema, sqliteDomainRequestSchema } from "../../shared/src/sqlite-domain";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteScriptUploadReceiptSchema } from "./sqlite-cloudflare";
import { createLocalJournalStorage } from "./local-journal-storage";
import { domainAttachmentMatches, requireSqliteDomainAttachment, sqliteDomainAttachmentSchema } from "./sqlite-domain-attachment";

const deployment = z.object({ worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256) }).strict();
export const sqliteDomainJournalSchema = z.object({ schema_version: z.literal(1), request: sqliteDomainRequestSchema,
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/), previous: deployment.extend({ namespace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
  phase: z.enum(["prepared", "maintenance", "attachment_acknowledged", "connected", "configured",
    "deploy_acknowledged", "deployed", "verified", "commit_requested", "remote_ready", "local_synced",
    "detached", "completed"]),
  attachment_acknowledgement: sqliteDomainAttachmentSchema.optional(),
  connection: sqliteDomainConnectionSchema.optional(), upload_receipt: sqliteScriptUploadReceiptSchema.optional(),
  receipt: deployment.optional(), commit: sqliteDomainCommitSchema.optional(),
  detach_acknowledged: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  const phases = ["prepared", "maintenance", "attachment_acknowledged", "connected", "configured",
    "deploy_acknowledged", "deployed", "verified", "commit_requested", "remote_ready", "local_synced",
    "detached", "completed"];
  const at = (phase: string) => phases.indexOf(value.phase) >= phases.indexOf(phase);
  if (value.connection) {
    try { requireSqliteDomainConnection(value.connection, value.request); }
    catch { context.addIssue({ code: "custom", message: "Domain journal connection differs from its frozen target" }); }
  }
  if (value.attachment_acknowledgement) {
    try { requireSqliteDomainAttachment(value.attachment_acknowledgement, value.request); }
    catch { context.addIssue({ code: "custom", message: "Domain attachment acknowledgement differs from its frozen target" }); }
  }
  if ((value.request.action === "add" && at("attachment_acknowledged")) !== !!value.attachment_acknowledgement ||
    value.request.action === "remove" && value.phase === "attachment_acknowledged" ||
    value.connection && value.attachment_acknowledgement && !domainAttachmentMatches(value.attachment_acknowledgement, value.connection) ||
    at("connected") !== !!value.connection || at("deploy_acknowledged") !== !!value.upload_receipt ||
    at("deployed") !== !!value.receipt || at("commit_requested") !== !!value.commit ||
    value.previous.namespace_id !== value.request.namespace_id ||
    value.receipt && (value.receipt.script_etag !== value.upload_receipt?.script_etag || value.receipt.worker_version_id === value.previous.worker_version_id || value.receipt.deployment_id === value.previous.deployment_id) ||
    value.commit && (value.commit.operation_id !== value.request.operation_id || value.commit.request_sha256 !== value.request_sha256 ||
      value.commit.worker_version_id !== value.receipt?.worker_version_id || value.commit.deployment_id !== value.receipt?.deployment_id ||
      value.commit.script_etag !== value.receipt?.script_etag || JSON.stringify(value.commit.connection) !== JSON.stringify(value.connection)) ||
    (value.request.action === "remove" && at("detached")) !== (value.detach_acknowledged === true) ||
    value.request.action === "add" && value.phase === "detached") {
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
