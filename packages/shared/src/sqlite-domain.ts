import { z } from "zod";
import { sha256Hex } from "./sha256";
import { sqlitePublicationRuntimeSchema } from "./sqlite-publication";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "./sqlite-service";

export const SQLITE_DOMAIN_PROTOCOL = "sqlite-domain-change-v1" as const;
const hash = sqlitePublicationRuntimeSchema.shape.service_config_sha256;
const cloudflareId = z.string().regex(/^[a-f0-9]{32}$/);

export const sqliteDomainHostnameSchema = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i)
  .transform((value) => value.toLowerCase()).refine((value) => {
    const labels = value.split(".");
    return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) &&
      !label.startsWith("xn--")) && /^[a-z]{2,63}$/.test(labels.at(-1)!) && !value.endsWith(".workers.dev");
  }, "Expected an ASCII DNS hostname without a scheme, port, wildcard or IP address");

export const sqliteDomainConnectionSchema = z.object({
  id: cloudflareId, cert_id: z.uuid(), hostname: sqliteDomainHostnameSchema,
  zone_id: cloudflareId, zone_name: sqliteDomainHostnameSchema, service: sqliteServiceConfigSchema.shape.worker_name,
  environment: z.literal("production"), enabled: z.literal(true), previews_enabled: z.literal(false),
}).strict().superRefine((value, context) => {
  if (!value.hostname.endsWith(`.${value.zone_name}`)) {
    context.addIssue({ code: "custom", message: "Domain connection must belong to its exact parent zone" });
  }
});
export type SqliteDomainConnection = z.infer<typeof sqliteDomainConnectionSchema>;

export const sqliteDomainRequestSchema = z.object({
  schema_version: z.literal(1), protocol: z.literal(SQLITE_DOMAIN_PROTOCOL), operation_id: z.uuid(),
  action: z.enum(["add", "remove"]), hostname: sqliteDomainHostnameSchema,
  zone_id: cloudflareId, zone_name: sqliteDomainHostnameSchema,
  namespace_id: cloudflareId, previous_runtime: sqlitePublicationRuntimeSchema,
  previous_config: sqliteServiceConfigSchema, target_config: sqliteServiceConfigSchema,
  target_config_sha256: hash, worker_source_sha256: hash, worker_metadata_sha256: hash,
  connection: sqliteDomainConnectionSchema.optional(),
}).strict().superRefine((value, context) => {
  const previous = value.previous_config, target = value.target_config;
  const { public_base_url: previousPublic, ...previousFixed } = previous;
  const { public_base_url: targetPublic, ...targetFixed } = target;
  const management = previous.workers_dev_base_url, custom = `https://${value.hostname}`;
  if (JSON.stringify(previousFixed) !== JSON.stringify(targetFixed) ||
    value.previous_runtime.service_id !== previous.service_id ||
    value.previous_runtime.service_config_sha256 === value.target_config_sha256 ||
    !value.hostname.endsWith(`.${value.zone_name}`) ||
    (value.action === "add" ? previousPublic !== management || targetPublic !== custom :
      previousPublic !== custom || targetPublic !== management) ||
    (value.action === "remove") !== (value.connection !== undefined) ||
    value.connection && (value.connection.hostname !== value.hostname || value.connection.zone_id !== value.zone_id ||
      value.connection.zone_name !== value.zone_name || value.connection.service !== previous.worker_name)) {
    context.addIssue({ code: "custom", message: "Domain change requires an exact subdomain and only a public origin change" });
  }
});

export type SqliteDomainRequest = z.infer<typeof sqliteDomainRequestSchema>;

export async function parseSqliteDomainRequest(input: unknown): Promise<SqliteDomainRequest> {
  const request = sqliteDomainRequestSchema.parse(input);
  if (await sqliteServiceConfigHash(request.previous_config) !== request.previous_runtime.service_config_sha256 ||
    await sqliteServiceConfigHash(request.target_config) !== request.target_config_sha256) {
    throw new Error("Domain change configuration hashes differ from the frozen input");
  }
  return request;
}

export async function sqliteDomainRequestHash(input: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(await parseSqliteDomainRequest(input)));
}

export function requireSqliteDomainConnection(input: unknown, request: SqliteDomainRequest): SqliteDomainConnection {
  const connection = sqliteDomainConnectionSchema.parse(input), expected = sqliteDomainRequestSchema.parse(request);
  if (connection.hostname !== expected.hostname || connection.zone_id !== expected.zone_id ||
    connection.zone_name !== expected.zone_name || connection.service !== expected.previous_config.worker_name ||
    expected.connection && JSON.stringify(connection) !== JSON.stringify(expected.connection)) {
    throw new Error("Domain connection differs from its frozen Worker, hostname or zone");
  }
  return connection;
}
