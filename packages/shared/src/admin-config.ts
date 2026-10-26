import * as TOML from "@iarna/toml";
import { z } from "zod";
import { timeZoneSchema } from "./time-zone";

export const adminTimezoneSchema = timeZoneSchema;

export const adminConfigSchema = z.object({
  schema_version: z.literal(1),
  timezone: adminTimezoneSchema.optional(),
}).strict();

export type AdminConfig = z.infer<typeof adminConfigSchema>;

export function parseAdminConfig(source: string): AdminConfig {
  return adminConfigSchema.parse(TOML.parse(source));
}
