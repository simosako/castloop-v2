import { serviceConfigSchema, stageReadbackReceiptSchema, stageUploadRequestSchema } from "@castloop/shared";
import type { ServiceConfig, StageReadbackReceipt } from "@castloop/shared";
import { stagingClientTargets } from "./staging-client";
import type { StagePutTarget } from "./staging-client";
import type { FrozenStagingSources } from "./staging-sources";
import { createHash } from "node:crypto";

export type StagingRestTransport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
export type StagingRestOptions = {
  accountId: string;
  apiToken: string;
  transport?: StagingRestTransport;
  timeoutMs?: number;
};

async function readReceipt(response: Response, target: StagePutTarget): Promise<Pick<StageReadbackReceipt, "etag" | "version">> {
  if (!response.body) throw new Error("Staging PUT receipt is missing");
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) throw new Error("Staging PUT receipt exceeds its limit");
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || !("success" in value) || value.success !== true || !("result" in value) ||
      !value.result || typeof value.result !== "object" || !("size" in value.result)) {
      throw new Error("Staging PUT receipt size/success was not verified");
    }
    const received = typeof value.result.size === "string" && /^\d+$/.test(value.result.size) ? Number(value.result.size) : value.result.size;
    if (typeof received !== "number" || !Number.isSafeInteger(received) || received !== target.length ||
      !("key" in value.result) || value.result.key !== target.key || !("etag" in value.result) || !("version" in value.result)) {
      throw new Error("Staging PUT receipt size/success was not verified");
    }
    return { etag: stageReadbackReceiptSchema.shape.etag.parse(value.result.etag),
      version: stageReadbackReceiptSchema.shape.version.parse(value.result.version) };
  } finally { await reader.cancel(); reader.releaseLock(); }
}

async function verifyResponse(response: Response, target: StagePutTarget, etag: string): Promise<string> {
  if (!response.body || response.status !== 200 || response.headers.has("content-range")) throw new Error("Staging verification requires a complete object response");
  const reader = response.body.getReader();
  try {
    if (response.headers.get("ETag") !== `"${etag}"`) throw new Error("Staging readback differs from its PUT object identity");
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > target.length) throw new Error("Staging verification size exceeds its frozen manifest");
      hash.update(chunk.value);
    }
    const sha256 = hash.digest("hex");
    if (size !== target.length || sha256 !== target.sha256) throw new Error("Staging verification checksum/size differs from its frozen manifest");
    return sha256;
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export function createStagingRestPut(configInput: ServiceConfig, sources: FrozenStagingSources,
  options: StagingRestOptions = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" }):
  (target: StagePutTarget, index: number) => Promise<StageReadbackReceipt> {
  const config = serviceConfigSchema.parse(configInput);
  const upload = stageUploadRequestSchema.parse(sources.upload);
  if (options.accountId !== config.account_id || !options.apiToken || /[\r\n]/.test(options.apiToken)) throw new Error("Staging REST credentials do not match the service account");
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new Error("Invalid staging REST timeout");
  const transport = options.transport ?? fetch;
  const apiToken = options.apiToken;
  const targets = stagingClientTargets(upload);
  const used = new Set<number>();
  const types = { show_metadata: "application/toml", episode_metadata: "application/toml", cover_jpg: "image/jpeg", cover_png: "image/png", audio: "audio/mpeg" };
  return async (target, index) => {
    if (!Number.isInteger(index) || !targets[index] || JSON.stringify(target) !== JSON.stringify(targets[index]) || used.has(index)) {
      throw new Error("Staging REST PUT requires its exact one-time key, size and checksum");
    }
    used.add(index);
    let readback: StageReadbackReceipt | undefined;
    await sources.withPayload(index, async (body, requireConsumed) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const url = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/${config.bucket_name}/objects/${target.key}`;
      let response: Response | undefined;
      try {
        response = await transport(url, { method: "PUT", body, redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": types[upload.payloads[index]!.asset], "Content-Length": String(target.length) } });
        if (response.status !== 200) throw new Error("Staging REST PUT failed or has an unknown outcome");
        const receipt = await readReceipt(response, target);
        requireConsumed();
        response = await transport(url, { method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiToken}`, "Accept-Encoding": "identity" } });
        const sha256 = await verifyResponse(response, target, receipt.etag);
        readback = stageReadbackReceiptSchema.parse({ ...upload.payloads[index], sha256, ...receipt });
      } catch {
        throw new Error("Staging REST PUT/verification failed; no automatic retry or remote termination proof");
      } finally {
        controller.abort();
        clearTimeout(timer);
        if (response?.body && !response.body.locked) {
          try { await response.body.cancel(); } catch { throw new Error("Staging REST response cancellation failed; no automatic retry"); }
        }
      }
    });
    if (!readback) throw new Error("Staging readback receipt is missing");
    return readback;
  };
}
