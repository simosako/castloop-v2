import { z } from "zod";
import { sqliteAccessStatsSourceSchema } from "../../shared/src/sqlite-access-stats";
import { sqliteDomainHostnameSchema } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { createLocalJournalStorage, readLocalJournalOrNull } from "./local-journal-storage";

export const LOGPUSH_FIELDS = ["EdgeStartTimestamp", "RayID", "ClientRequestHost", "ClientRequestPath",
  "ClientRequestMethod", "EdgeResponseStatus", "EdgeResponseBodyBytes", "CacheCacheStatus",
  "ClientRequestSource", "WorkerSubrequest"] as const;
export const LOGPUSH_RETENTION_DAYS = 400;
export const logpushZoneIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const settings = z.object({ hosts: z.array(sqliteDomainHostnameSchema).min(1), enabled: z.boolean() }).strict();
const zone = z.object({ zone_id: logpushZoneIdSchema, operation_id: z.uuid(), settings,
  previous_settings: settings.nullable(), job_id: z.number().int().positive().nullable(), token_id: logpushZoneIdSchema.nullable(),
  sources: z.array(sqliteAccessStatsSourceSchema).min(1) }).strict().refine((value) =>
  new Set(value.settings.hosts).size === value.settings.hosts.length && value.sources.length === value.settings.hosts.length &&
  value.sources.every((source, index) => source.zone_id === value.zone_id && source.host === value.settings.hosts[index]),
  "Logpush sources differ from the configured hosts");
export type LogpushZone = z.infer<typeof zone>;
export const logpushConfigurationSchema = z.object({ schema_version: z.literal(1),
  service_id: sqliteServiceConfigSchema.shape.service_id, account_id: sqliteServiceConfigSchema.shape.account_id,
  worker_name: sqliteServiceConfigSchema.shape.worker_name, workers_dev_base_url: z.string(),
  origin_bucket_name: sqliteServiceConfigSchema.shape.bucket_name, bucket_name: sqliteServiceConfigSchema.shape.bucket_name,
  created_at_ms: timestamp, zones: z.array(zone) }).strict().refine((value) =>
  value.bucket_name !== value.origin_bucket_name && new Set(value.zones.map((entry) => entry.zone_id)).size === value.zones.length,
  "Logpush bucket or zone identities differ").refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 16384,
  "Logpush configuration exceeds its local record budget");
export type LogpushConfiguration = z.infer<typeof logpushConfigurationSchema>;

export function logpushConfigurationStorage(root: string, config: SqliteServiceConfig) {
  return createLocalJournalStorage(root, "logpush", config.service_id, "configuration.json");
}
export function readLogpushConfiguration(root: string, config: SqliteServiceConfig): LogpushConfiguration | null {
  const value = readLocalJournalOrNull(logpushConfigurationStorage(root, config), logpushConfigurationSchema);
  if (value && (value.service_id !== config.service_id || value.account_id !== config.account_id ||
    value.worker_name !== config.worker_name || value.workers_dev_base_url !== config.workers_dev_base_url ||
    value.origin_bucket_name !== config.bucket_name)) throw new Error("Logpush configuration belongs to another service target");
  return value;
}
export function logpushJobName(zone: LogpushZone): string { return `castloop-logs-${zone.operation_id}`; }
export function logpushTokenName(zone: LogpushZone): string { return `castloop-logpush-${zone.operation_id}`; }
export function logpushPrefix(config: Pick<LogpushConfiguration, "service_id">, zoneId: string): string {
  return `http/${config.service_id}/${zoneId}/`;
}
export function logpushFilter(hosts: readonly string[]): string {
  const predicate = (key: string, operator: string, value: unknown) => ({ key, operator, value });
  const filter = JSON.stringify({ where: { and: [
    predicate("ClientRequestHost", "in", hosts), predicate("ClientRequestMethod", "in", ["GET", "HEAD"]),
    predicate("EdgeResponseStatus", "in", [200, 206, 304]), predicate("ClientRequestSource", "eq", "eyeball"),
    predicate("WorkerSubrequest", "eq", false), predicate("ClientRequestPath", "startsWith", "/podcasts/"),
    { or: [".mp3", "/cover.jpg", "/cover.png"].map((suffix) => predicate("ClientRequestPath", "endsWith", suffix)) },
  ] } });
  if (Buffer.byteLength(filter) > 1000) throw new Error("Logpush host filter exceeds Cloudflare's 1000-byte limit");
  return filter;
}
