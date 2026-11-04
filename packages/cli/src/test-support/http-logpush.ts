import { accessStatsResourceSchema } from "../../../shared/src/access-stats";
import type { R2RestTransport } from "../bounded-http-read";
import type { HttpLogpushFile } from "../http-logpush-r2";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const logTarget = { accountId: "a".repeat(32), bucketName: "private-logs", serviceId: "service",
  zoneId: "b".repeat(32), hostname: "media.example.com" };
export const logPrefix = `http/${logTarget.serviceId}/${logTarget.zoneId}/`;
export const logAudio = accessStatsResourceSchema.parse({ show_id: "daily", resource_kind: "audio", episode_id: "first",
  audio_revision_id: "11111111-1111-4111-8111-111111111111",
  resource_path: "/podcasts/daily/episodes/first/11111111-1111-4111-8111-111111111111.mp3" });
export const logRecord = { EdgeStartTimestamp: "2026-11-04T12:00:00Z", RayID: "7b52f2c4f9f64c1a",
  ClientRequestHost: logTarget.hostname, ClientRequestPath: logAudio.resource_path, ClientRequestMethod: "GET",
  EdgeResponseStatus: 200, EdgeResponseBodyBytes: 120_000, CacheCacheStatus: "hit" as const,
  ClientRequestSource: "eyeball", WorkerSubrequest: false };

export type TestLogObject = { file: HttpLogpushFile; body: Uint8Array<ArrayBuffer> };

export function logObject(name: string, source: string | Uint8Array): TestLogObject {
  const body = new Uint8Array(gzipSync(source));
  return { body, file: { key: `${logPrefix}${name}`, size: body.length,
    etag: createHash("md5").update(body).digest("hex") } };
}

export function logR2Fixture(initial: TestLogObject[], pageSize = 1000) {
  const objects = new Map(initial.map((object) => [object.file.key, object]));
  const requests: Request[] = [];
  const bodyReads: string[] = [];
  const transport: R2RestTransport = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    requests.push(request);
    const base = `/client/v4/accounts/${logTarget.accountId}/r2/buckets/${logTarget.bucketName}/objects`;
    if (url.origin !== "https://api.cloudflare.com" || request.method !== "GET" || !url.pathname.startsWith(base)) {
      throw new Error("Unexpected log R2 request");
    }
    if (url.pathname === base) {
      const files = [...objects.values()].filter((object) => object.file.key.startsWith(url.searchParams.get("prefix") ?? ""))
        .map((object) => object.file).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const start = Number(url.searchParams.get("cursor") ?? 0), page = files.slice(start, start + pageSize);
      const next = start + pageSize;
      return Response.json({ success: true, result: page.map((file) => ({ ...file, http_metadata: { contentEncoding: "gzip" } })),
        result_info: { is_truncated: next < files.length, cursor: next < files.length ? String(next) : "" } });
    }
    const key = decodeURIComponent(url.pathname.slice(base.length + 1));
    bodyReads.push(key);
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, { headers: { ETag: `"${object.file.etag}"`, "Content-Length": String(object.body.length),
      "Content-Type": "application/x-ndjson", "Content-Encoding": "gzip" } });
  };
  return { objects, requests, bodyReads, transport };
}
