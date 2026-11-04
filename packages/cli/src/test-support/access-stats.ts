import { setSystemTime } from "bun:test";
import { runLogpushCommand } from "../logpush";
import { readLogpushConfiguration } from "../logpush-config";
import { runSqliteCommand } from "../sqlite-commands";
import { SqliteServiceClient } from "../sqlite-service-client";
import { administratorKey } from "../administrator-key";
import type { R2RestTransport } from "../bounded-http-read";
import { logpushFixture } from "./logpush";
import { logObject } from "./http-logpush";
import type { TestLogObject } from "./http-logpush";
import { TEST_COVER_JPEG, TEST_MP3 } from "./media";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function accessStatsFixture(ageDays = 3) {
  const now = Date.now(), start = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) - ageDays * 86400000;
  setSystemTime(start);
  let f: Awaited<ReturnType<typeof logpushFixture>> | undefined;
  try {
    f = await logpushFixture();
    const command = (name: string, args: string[]) => runSqliteCommand(f!.root, f!.config, name, args, { transport: f!.transport, cloudflare: f!.options });
    await command("create-show", ["daily", "https://example.com"]);
    writeFileSync(join(f.root, "daily", "cover.jpg"), TEST_COVER_JPEG);
    await command("publish-show", ["daily"]);
    await command("create-episode", ["daily", "first"]);
    writeFileSync(join(f.root, "daily", "audio.mp3"), TEST_MP3);
    await command("publish-episode", ["daily", "first", "audio.mp3"]);
    const transport: R2RestTransport = async (input, init) => {
      const response = await f!.transport(input, init);
      if (init?.method === "POST" && String(input).endsWith("/logpush/jobs")) setSystemTime(start + 1000);
      return response;
    };
    await runLogpushCommand(f.root, f.config, "setup", { zoneId: f.zoneId, bucketName: "access-logs" }, { ...f.options, transport });
  } catch (error) { f?.close(); throw error; }
  finally { setSystemTime(); }
  const fixture = f!, objects = new Map<string, TestLogObject>(), requests: Request[] = [];
  const prefix = `http/${fixture.config.service_id}/${fixture.zoneId}/`;
  const base = `/client/v4/accounts/${fixture.config.account_id}/r2/buckets/access-logs/objects`;
  const transport: R2RestTransport = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    requests.push(request.clone());
    if (url.hostname !== "api.cloudflare.com" || !url.pathname.startsWith(base)) return fixture.transport(request);
    if (request.method !== "GET" || request.headers.get("Authorization") !== "Bearer private-token") return new Response(null, { status: 403 });
    if (url.pathname === base) {
      const all = [...objects.values()].map((object) => object.file).filter((file) => file.key.startsWith(url.searchParams.get("prefix") ?? ""))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const at = Number(url.searchParams.get("cursor") ?? 0), page = all.slice(at, at + 2);
      return Response.json({ success: true, result: page, result_info: { is_truncated: at + 2 < all.length,
        cursor: at + 2 < all.length ? String(at + 2) : "" } });
    }
    const key = decodeURIComponent(url.pathname.slice(base.length + 1)), object = objects.get(key);
    return object ? new Response(object.body, { headers: { ETag: `"${object.file.etag}"`, "Content-Encoding": "gzip",
      "Content-Length": String(object.body.length), "Content-Type": "application/x-ndjson" } }) : new Response(null, { status: 404 });
  };
  const client = new SqliteServiceClient(fixture.config, administratorKey(fixture.root), transport);
  const approved = await client.accessResources("daily"), audio = approved.resources.find((resource) => resource.resource_kind === "audio")!,
    cover = approved.resources.find((resource) => resource.resource_kind === "cover")!;
  const source = readLogpushConfiguration(fixture.root, fixture.config)!.zones[0]!.sources[0]!;
  const date = (daysAgo: number) => new Date(Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) - daysAgo * 86400000).toISOString().slice(0, 10);
  const record = (id: string, day = date(2), extra: object = {}) => ({ EdgeStartTimestamp: `${day}T12:00:00Z`, RayID: id,
    ClientRequestHost: source.host, ClientRequestPath: audio.resource_path, ClientRequestMethod: "GET", EdgeResponseStatus: 200,
    EdgeResponseBodyBytes: 120000, CacheCacheStatus: "hit", ClientRequestSource: "eyeball", WorkerSubrequest: false, ...extra });
  requests.length = 0;
  return { ...fixture, source, audio, cover, client, date, record, objects, requests, transport, options: { ...fixture.options, transport },
    putFile(name: string, contents: string) {
      const object = logObject(name, contents); object.file.key = `${prefix}${name}`;
      objects.set(object.file.key, object); return object;
    },
    putLogs(name: string, records: object[]) {
      const object = logObject(name, records.map((record) => JSON.stringify(record)).join("\n")); object.file.key = `${prefix}${name}`;
      objects.set(object.file.key, object); return object;
    } };
}
