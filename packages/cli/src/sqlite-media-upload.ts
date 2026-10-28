import { z } from "zod";
import { sqliteMediaKey, sqliteAudioReferenceSchema, sqliteCoverReferenceSchema } from "../../shared/src/sqlite-media";
import type { SqliteAudioReference, SqliteCoverReference } from "../../shared/src/sqlite-media";
import { collectStreamBytes } from "./bounded-http-read";
import { freezePayloadSources } from "./staging-sources";
import { requireR2RestOptions } from "./verified-r2-put";
import type { R2RestOptions } from "./verified-r2-put";

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
  const asset = cover ? extension === "png" ? "cover_png" : "cover_jpg" : "audio";
  const sources = await freezePayloadSources(root, [{ asset, sha256: media.sha256, length_bytes: media.length_bytes }], [path]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300000);
  const transport = options.transport ?? fetch;
  const headers = { Authorization: `Bearer ${options.apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}/r2/buckets/${encodeURIComponent(config.bucket_name)}/objects`;
  let response: Response | undefined;
  try {
    await sources.withPayload(0, async (body, requireConsumed) => {
      response = await transport(`${base}/${key.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT", body, redirect: "error", signal: controller.signal,
        headers: { ...headers, "Content-Type": cover ? extension === "png" ? "image/png" : "image/jpeg" : "audio/mpeg",
          "Content-Length": String(media.length_bytes) },
      });
      if (response.status !== 200) throw new Error("R2 media PUT failed or has an unknown outcome");
      const receipt = receiptSchema.parse(await readJson(response)).result;
      if (receipt.key !== key || receipt.size !== media.length_bytes) throw new Error("R2 media PUT key or size differs from the local input");
      requireConsumed();
    });
    await sources.assertCurrent();
  } finally {
    controller.abort();
    clearTimeout(timer);
    try {
      if (response?.body && !response.body.locked) await response.body.cancel();
    } finally { await sources.dispose(); }
  }
}
