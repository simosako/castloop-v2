import * as TOML from "@iarna/toml";
import { z } from "zod";

export const adminTimezoneSchema = z.string().max(128)
  .regex(/^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/)
  .refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
    catch { return false; }
  }, "Expected UTC or a supported IANA time zone name, not an abbreviation");

export const adminConfigSchema = z.object({
  schema_version: z.literal(1),
  timezone: adminTimezoneSchema.optional(),
}).strict();

export type AdminConfig = z.infer<typeof adminConfigSchema>;

export function parseAdminConfig(source: string): AdminConfig {
  return adminConfigSchema.parse(TOML.parse(source));
}
