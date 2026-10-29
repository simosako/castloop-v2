import { z } from "zod";
import { sqliteMediaKey, sqliteAudioReferenceSchema, sqliteCoverReferenceSchema } from "../../shared/src/sqlite-media";
import type { SqliteAudioReference, SqliteCoverReference } from "../../shared/src/sqlite-media";
import { collectStreamBytes, requireR2RestOptions } from "./bounded-http-read";
import type { R2RestOptions } from "./bounded-http-read";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("R2 response is missing");
  const bytes = await collectStreamBytes(response.body, 65536, true);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

const receiptSchema = z.object({ success: z.literal(true), result: z.object({
  key: z.string(), size: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]),
}) });

export async function uploadSqliteMedia(root: string, config: { account_id: string; bucket_name: string }, showId: string,
  path: string, media: SqliteAudioReference | SqliteCoverReference, options: R2RestOptions): Promise<void> {
  requireR2RestOptions(config.account_id, options);
  media = "extension" in media ? sqliteCoverReferenceSchema.parse(media) : sqliteAudioReferenceSchema.parse(media);
  const key = sqliteMediaKey(showId, media);
  const extension = "extension" in media ? media.extension : null;
  const cover = extension !== null;
  const sourcePath = resolve(root, path);
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = handle.createReadStream();
  const settled = finished(stream, { cleanup: true }).catch(() => undefined);
  const iterator = stream[Symbol.asyncIterator]();
  const expected = media.length_bytes;
  let length = 0;
  let completed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await iterator.next();
      if (chunk.done) throw new Error("Local media source ended before its expected size");
      length += chunk.value.length;
      if (length > expected) throw new Error("Local media source grew during upload");
      if (length === expected) {
        if (!(await iterator.next()).done) throw new Error("Local media source grew during upload");
        completed = true;
        controller.enqueue(chunk.value);
        controller.close();
      } else controller.enqueue(chunk.value);
    },
    cancel() { stream.destroy(); },
  }, { highWaterMark: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300000);
  const transport = options.transport ?? fetch;
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}/r2/buckets/${encodeURIComponent(config.bucket_name)}/objects`;
  let response: Response | undefined;
  try {
    response = await transport(`${base}/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT", body, redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": cover ? extension === "png" ? "image/png" : "image/jpeg" : "audio/mpeg",
        "Content-Length": String(media.length_bytes) },
    });
    if (response.status !== 200) throw new Error("R2 media PUT failed or has an unknown outcome");
    const receipt = receiptSchema.parse(await readJson(response)).result;
    if (receipt.key !== key || receipt.size !== media.length_bytes) throw new Error("R2 media PUT key or size differs from the local input");
    if (!completed) throw new Error("PUT responded before its source stream finished");
  } finally {
    controller.abort();
    clearTimeout(timer);
    stream.destroy();
    await settled;
    await handle.close();
    if (response?.body && !response.body.locked) await response.body.cancel();
  }
}
