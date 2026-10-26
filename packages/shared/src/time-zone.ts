import { z } from "zod";

export const timeZoneSchema = z.string().max(128)
  .regex(/^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/)
  .refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
    catch { return false; }
  }, "Expected UTC or a supported IANA time zone name, not an abbreviation");
