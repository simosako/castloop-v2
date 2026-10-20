import * as TOML from "@iarna/toml";
import { z } from "zod";
import { sqlitePublicationProtocol, sqlitePublicationRuntimeSchema } from "./sqlite-publication";
import { sha256Hex } from "./sha256";

const resourceName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    !url.search && !url.hash && url.pathname === "/";
}, "Expected an HTTPS origin without credentials, path, query or port").transform((value) => new URL(value).origin);

export const sqliteServiceConfigSchema = z.object({ schema_version: z.literal(2),
  storage_layout: z.literal("show-v1"),
  publication_protocol: z.literal(sqlitePublicationProtocol), service_id: sqlitePublicationRuntimeSchema.shape.service_id,
  account_id: z.string().regex(/^[a-f0-9]{32}$/i), bucket_name: resourceName, worker_name: resourceName,
  public_base_url: origin, workers_dev_base_url: origin,
}).strict().superRefine((value, context) => {
  const labels = new URL(value.workers_dev_base_url).hostname.split(".");
  if (labels.length !== 4 || labels[0] !== value.worker_name || labels[2] !== "workers" || labels[3] !== "dev" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[1]!)) {
    context.addIssue({ code: "custom", path: ["workers_dev_base_url"], message: "Expected this Worker's workers.dev origin" });
  }
});

export const sqliteServiceStatusSchema = sqlitePublicationRuntimeSchema.extend({
  show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  protocol: z.literal(sqlitePublicationProtocol), state: z.enum(["open", "paused"]),
  admission_window_id: z.uuid().nullable(), publication_ready: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.state === "open" && value.admission_window_id === null) {
    context.addIssue({ code: "custom", message: "Open admission requires an explicit resume window" });
  }
});

export type SqliteServiceConfig = z.infer<typeof sqliteServiceConfigSchema>;
export type SqliteServiceStatus = z.infer<typeof sqliteServiceStatusSchema>;

export function parseSqliteServiceConfig(source: string): SqliteServiceConfig {
  return sqliteServiceConfigSchema.parse(TOML.parse(source));
}

export async function sqliteServiceConfigHash(input: SqliteServiceConfig): Promise<string> {
  return sha256Hex(JSON.stringify(sqliteServiceConfigSchema.parse(input)));
}
