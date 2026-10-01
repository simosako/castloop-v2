import { z } from "zod";

export const publishedTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
).refine((value) => {
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const offset = value.slice(19);
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return false;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return local.getUTCFullYear() === year && local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day && local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute && local.getUTCSeconds() === second;
}, "Expected a valid RFC 3339 timestamp");
