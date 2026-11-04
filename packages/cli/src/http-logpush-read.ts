import { z } from "zod";
import type { AccessStatsEvent, AccessStatsResource } from "../../shared/src/access-stats";
import { validateId } from "../../shared/src/ids";
import { AccessLogFileIndex } from "./access-log-file-index";
import type { AccessLogFileRange } from "./access-log-file-index";
import type { R2RestOptions } from "./bounded-http-read";
import { httpLogpushRecordToEvent } from "./http-logpush-events";
import type { HttpLogpushSource } from "./http-logpush-events";
import { HttpLogpushR2 } from "./http-logpush-r2";
import type { HttpLogpushFile, HttpLogpushLocation } from "./http-logpush-r2";

export type HttpLogpushReadSelection = { showId: string; fromDateUtc: string; toDateUtc: string };
export type HttpLogpushReadSummary = { inputFiles: HttpLogpushFile[]; newOutsideDatesUtc: string[] };

const selectionSchema = z.object({ showId: z.string(), fromDateUtc: z.iso.date(), toDateUtc: z.iso.date() }).strict();
const DAY_MS = 86_400_000;

export async function readHttpLogpushLogs(root: string, target: HttpLogpushLocation & HttpLogpushSource,
  selection: HttpLogpushReadSelection, resources: ReadonlyMap<string, AccessStatsResource>,
  onEvent: (event: AccessStatsEvent) => void | Promise<void>, options: R2RestOptions): Promise<HttpLogpushReadSummary> {
  if (!selectionSchema.safeParse(selection).success) throw new Error("Invalid Logpush log read selection");
  validateId(selection.showId, "show");
  const fromMs = Date.parse(`${selection.fromDateUtc}T00:00:00Z`);
  const untilMs = Date.parse(`${selection.toDateUtc}T00:00:00Z`) + DAY_MS;
  if (untilMs <= fromMs || untilMs - fromMs > 366 * DAY_MS) throw new Error("Logpush log read window must span 1 to 366 UTC days");
  const r2 = new HttpLogpushR2(target, options);
  const files = await r2.listFiles();
  const index = new AccessLogFileIndex(root);
  const inputFiles: HttpLogpushFile[] = [];
  const newOutsideDates = new Set<string>();
  const overlaps = (range: AccessLogFileRange) => range.minOccurredAtMs !== null && range.maxOccurredAtMs !== null &&
    range.minOccurredAtMs < untilMs && range.maxOccurredAtMs >= fromMs;
  try {
    for (const file of files) {
      const cached = index.get(target, file);
      if (cached && !overlaps(cached)) continue;
      const range: AccessLogFileRange = { minOccurredAtMs: null, maxOccurredAtMs: null };
      await r2.readFile(file, async (record) => {
        const at = record.EdgeStartTimestamp;
        range.minOccurredAtMs = range.minOccurredAtMs === null ? at : Math.min(range.minOccurredAtMs, at);
        range.maxOccurredAtMs = range.maxOccurredAtMs === null ? at : Math.max(range.maxOccurredAtMs, at);
        if (!cached && (at < fromMs || at >= untilMs)) newOutsideDates.add(new Date(at).toISOString().slice(0, 10));
        const event = httpLogpushRecordToEvent(record, target, resources);
        if (event && event.show_id === selection.showId && at >= fromMs && at < untilMs) await onEvent(event);
      });
      if (!cached) index.put(target, file, range);
      if (overlaps(range)) inputFiles.push(file);
    }
    return { inputFiles, newOutsideDatesUtc: [...newOutsideDates].sort() };
  } finally { index.close(); }
}
