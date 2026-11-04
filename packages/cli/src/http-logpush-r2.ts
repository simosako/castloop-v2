import { z } from "zod";
import { collectStreamBytes, requireR2RestOptions } from "./bounded-http-read";
import type { R2RestOptions } from "./bounded-http-read";
import { parseHttpLogpushRecord } from "./http-logpush-events";
import type { HttpLogpushRecord } from "./http-logpush-events";
import { decodeUtf8Strict } from "./utf8";

export type HttpLogpushLocation = { accountId: string; bucketName: string; serviceId: string; zoneId: string };
export type HttpLogpushFile = { key: string; etag: string; size: number };

const fileSchema = z.object({ key: z.string().min(1), etag: z.string().regex(/^[a-f0-9]+(?:-\d+)?$/),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const pageSchema = z.object({ success: z.literal(true), result: z.array(fileSchema).max(1000),
  result_info: z.object({ is_truncated: z.boolean(), cursor: z.string().optional() }) });

export class HttpLogpushR2 {
  private readonly base: string;
  private readonly prefix: string;

  constructor(location: HttpLogpushLocation, private readonly options: R2RestOptions) {
    requireR2RestOptions(location.accountId, options);
    this.base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(location.accountId)}/r2/buckets/${encodeURIComponent(location.bucketName)}/objects`;
    this.prefix = `http/${location.serviceId}/${location.zoneId.toLowerCase()}/`;
  }

  private async get(url: URL): Promise<Response> {
    let response: Response;
    try {
      const init = { method: "GET", redirect: "error" as const, cache: "no-store" as const,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000), decompress: false,
        headers: { Authorization: `Bearer ${this.options.apiToken}`, "Accept-Encoding": "identity" } };
      response = await (this.options.transport ?? fetch)(url, init);
    } catch { throw new Error("R2 log GET could not be completed"); }
    if (response.status !== 200 || !response.body || response.headers.has("Content-Range")) {
      try { await response.body?.cancel(); }
      catch { throw new Error("R2 log response cleanup failed"); }
      throw new Error(`R2 log GET was not verified (HTTP ${response.status})`);
    }
    return response;
  }

  async listFiles(): Promise<HttpLogpushFile[]> {
    const files: HttpLogpushFile[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const url = new URL(this.base);
      url.searchParams.set("prefix", this.prefix);
      url.searchParams.set("per_page", "1000");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await this.get(url);
      let page: z.infer<typeof pageSchema>;
      try {
        const bytes = await collectStreamBytes(response.body!, 8_388_608);
        page = pageSchema.parse(JSON.parse(decodeUtf8Strict(bytes)));
      } catch { throw new Error("R2 log listing was not verified"); }
      if (page.result.some((file) => !file.key.startsWith(this.prefix))) throw new Error("R2 log listing prefix differs");
      files.push(...page.result);
      if (!page.result_info.is_truncated) break;
      cursor = page.result_info.cursor;
      if (!cursor || cursors.has(cursor)) throw new Error("R2 log listing pagination was not verified");
      cursors.add(cursor);
    }
    return files.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }

  async readFile(file: HttpLogpushFile, onRecord: (record: HttpLogpushRecord) => void | Promise<void>): Promise<void> {
    const url = new URL(`${this.base}/${file.key.split("/").map(encodeURIComponent).join("/")}`);
    const response = await this.get(url);
    if (response.headers.get("ETag") !== `"${file.etag}"`) {
      await response.body!.cancel();
      throw new Error("R2 log file changed since listing");
    }
    let compressedBytes = 0;
    const counted = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        compressedBytes += chunk.byteLength;
        if (compressedBytes > file.size) throw new Error("R2 log file exceeds its listed size");
        controller.enqueue(chunk);
      },
      flush() {
        if (compressedBytes !== file.size) throw new Error("R2 log file differs from its listed size");
      },
    }));
    const reader = counted.pipeThrough(new DecompressionStream("gzip")).getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let pending = "";
    let terminal = false;
    const emit = async (line: string) => {
      if (line === "") return;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { throw new Error("Invalid JSON in HTTP Requests Logpush file"); }
      await onRecord(parseHttpLogpushRecord(value));
    };
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { terminal = true; throw new Error("R2 log file could not be read and decompressed completely"); }
        if (chunk.done) terminal = true;
        try { pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }); }
        catch { throw new Error("Invalid UTF-8 in HTTP Requests Logpush file"); }
        let start = 0;
        for (;;) {
          const end = pending.indexOf("\n", start);
          if (end === -1) break;
          await emit(pending.slice(start, end));
          start = end + 1;
        }
        pending = pending.slice(start);
        if (chunk.done) { await emit(pending); break; }
      }
    } finally {
      try { if (!terminal) await reader.cancel(); }
      catch { throw new Error("R2 log stream cleanup failed"); }
      finally { reader.releaseLock(); }
    }
  }
}
