import { Temporal } from "@js-temporal/polyfill";
import { adminTimezoneSchema } from "../../shared/src/admin-config";

export type ScheduleTimeOptions = { timezone?: string; configuredTimezone?: string };
export type ScheduleTime = {
  input: string;
  scheduled_at: string;
  scheduled_at_ms: number;
  input_offset: string | null;
  resolution_source: "offset" | "cli" | "config" | "server";
  timezone: string;
  timezone_source: "cli" | "config" | "server";
  local_datetime: string;
  offset: string;
};

export function resolveScheduleTime(input: string, options: ScheduleTimeOptions = {}): ScheduleTime {
  const match = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(input);
  if (!match || input.startsWith("0000-") || match[2] === "-00:00") {
    throw new Error("Expected an ISO date and time through seconds, with an optional known offset");
  }
  if (options.timezone !== undefined) adminTimezoneSchema.parse(options.timezone);
  if (options.configuredTimezone !== undefined) adminTimezoneSchema.parse(options.configuredTimezone);
  const timezone = options.timezone ?? options.configuredTimezone ?? "UTC";
  const timezoneSource = options.timezone !== undefined ? "cli" : options.configuredTimezone !== undefined ? "config" : "server";
  const inputOffset = match[2] === "Z" ? "+00:00" : match[2] ?? null;
  const local = Temporal.PlainDateTime.from(match[1]!, { overflow: "reject" });
  const instant = inputOffset === null ? local.toZonedDateTime(timezone, { disambiguation: "reject" }).toInstant() :
    Temporal.Instant.from(`${match[1]}${match[2]}`);
  const displayed = instant.toZonedDateTimeISO(timezone);
  if (inputOffset !== null && options.timezone !== undefined && displayed.offset !== inputOffset) {
    throw new Error("Explicit offset differs from --timezone at the requested date and time");
  }
  return {
    input, scheduled_at: instant.toString({ smallestUnit: "second" }), scheduled_at_ms: instant.epochMilliseconds,
    input_offset: inputOffset, resolution_source: inputOffset === null ? timezoneSource : "offset",
    timezone, timezone_source: timezoneSource,
    local_datetime: displayed.toPlainDateTime().toString({ smallestUnit: "second" }), offset: displayed.offset,
  };
}

export function requireFutureScheduleTime(time: ScheduleTime, serverNow: number): void {
  if (!Number.isSafeInteger(serverNow) || !Number.isSafeInteger(time.scheduled_at_ms) || time.scheduled_at_ms <= serverNow) {
    throw new Error("Schedule must be in the future according to the server clock; preview and approve a new time");
  }
}
