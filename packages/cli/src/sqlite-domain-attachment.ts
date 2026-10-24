import { z } from "zod";
import { sqliteDomainConnectionSchema, sqliteDomainRequestSchema } from "../../shared/src/sqlite-domain";
import type { SqliteDomainConnection, SqliteDomainRequest } from "../../shared/src/sqlite-domain";

export const sqliteDomainAttachmentSchema = z.object({ ...sqliteDomainConnectionSchema.shape,
  environment: z.enum(["", "production"]),
}).strict();
export type SqliteDomainAttachment = z.infer<typeof sqliteDomainAttachmentSchema>;

export function requireSqliteDomainAttachment(input: unknown, request: SqliteDomainRequest): SqliteDomainAttachment {
  const receipt = sqliteDomainAttachmentSchema.parse(input), expected = sqliteDomainRequestSchema.parse(request);
  if (expected.action !== "add" || receipt.hostname !== expected.hostname || receipt.zone_id !== expected.zone_id ||
    receipt.zone_name !== expected.zone_name || receipt.service !== expected.previous_config.worker_name) {
    throw new Error("Domain attachment acknowledgement differs from its frozen target");
  }
  return receipt;
}

export function domainAttachmentMatches(receipt: SqliteDomainAttachment, connection: SqliteDomainConnection): boolean {
  const { environment: _acknowledgedEnvironment, ...acknowledged } = receipt;
  const { environment: _verifiedEnvironment, ...verified } = connection;
  return JSON.stringify(acknowledged) === JSON.stringify(verified);
}
