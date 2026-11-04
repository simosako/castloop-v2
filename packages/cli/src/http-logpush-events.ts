import { z } from "zod";
import type { AccessStatsEvent, AccessStatsResource } from "../../shared/src/access-stats";

export type HttpLogpushSource = { zoneId: string; hostname: string };

const httpLogpushRecordSchema = z.object({
  EdgeStartTimestamp: z.iso.datetime({ offset: true, precision: 0 }).transform(Date.parse)
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
  RayID: z.string().min(1),
  ClientRequestHost: z.string(),
  ClientRequestPath: z.string(),
  ClientRequestMethod: z.string(),
  EdgeResponseStatus: z.number().int(),
  EdgeResponseBodyBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  CacheCacheStatus: z.enum(["unknown", "miss", "expired", "updating", "stale", "hit", "ignored",
    "bypass", "revalidated", "dynamic", "stream_hit", "deferred"]),
  ClientRequestSource: z.string(),
  WorkerSubrequest: z.boolean(),
}).strict();
export type HttpLogpushRecord = z.infer<typeof httpLogpushRecordSchema>;

export function parseHttpLogpushRecord(input: unknown): HttpLogpushRecord {
  const parsed = httpLogpushRecordSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid HTTP Requests Logpush record");
  return parsed.data;
}

export function httpLogpushRecordToEvent(record: HttpLogpushRecord, source: HttpLogpushSource,
  resources: ReadonlyMap<string, AccessStatsResource>): AccessStatsEvent | null {
  const host = source.hostname.toLowerCase();
  if (record.ClientRequestHost.toLowerCase() !== host || record.ClientRequestSource !== "eyeball" ||
    record.WorkerSubrequest) return null;
  const method = record.ClientRequestMethod, status = record.EdgeResponseStatus;
  if ((method !== "GET" && method !== "HEAD") || (status !== 200 && status !== 206 && status !== 304)) return null;
  const resource = resources.get(record.ClientRequestPath);
  if (!resource) return null;
  return {
    ...resource,
    source_id: `http_logpush:${source.zoneId.toLowerCase()}:${host}`,
    event_id: record.RayID,
    occurred_at_ms: record.EdgeStartTimestamp,
    host,
    method,
    status,
    response_bytes: method === "HEAD" || status === 304 ? 0 : record.EdgeResponseBodyBytes,
    cache_status: record.CacheCacheStatus,
  };
}
