import { stageReadbackReceiptSchema } from "@castloop/shared";
import type { StageReadbackReceipt } from "@castloop/shared";
import { createHash } from "node:crypto";

export type R2RestTransport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
export type R2RestOptions = { accountId: string; apiToken: string; transport?: R2RestTransport; timeoutMs?: number };
export type VerifiedR2Target = { key: string; length: number; sha256: string; contentType: string };
type ObjectReceipt = Pick<StageReadbackReceipt, "etag" | "version">;

async function readReceipt(response: Response, target: VerifiedR2Target): Promise<ObjectReceipt> {
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
    const sizeValue = value.result.size;
    const received = typeof sizeValue === "string" && /^\d+$/.test(sizeValue) ? Number(sizeValue) : sizeValue;
    if (typeof received !== "number" || !Number.isSafeInteger(received) || received !== target.length ||
      !("key" in value.result) || value.result.key !== target.key || !("etag" in value.result) || !("version" in value.result)) {
      throw new Error("Staging PUT receipt size/success was not verified");
    }
    return { etag: stageReadbackReceiptSchema.shape.etag.parse(value.result.etag),
      version: stageReadbackReceiptSchema.shape.version.parse(value.result.version) };
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

async function verifyResponse(response: Response, target: VerifiedR2Target, etag: string): Promise<void> {
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
    if (size !== target.length || hash.digest("hex") !== target.sha256) throw new Error("Staging verification checksum/size differs from its frozen manifest");
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

export function requireR2RestOptions(accountId: string, options: R2RestOptions): void {
  if (options.accountId !== accountId || !options.apiToken || /[\r\n]/.test(options.apiToken)) {
    throw new Error("Staging REST credentials do not match the service account");
  }
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new Error("Invalid staging REST timeout");
}

export async function putVerifiedR2Object(config: { account_id: string; bucket_name: string }, target: VerifiedR2Target,
  body: ReadableStream<Uint8Array>, requireConsumed: () => void, options: R2RestOptions): Promise<ObjectReceipt> {
  requireR2RestOptions(config.account_id, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300000);
  const transport = options.transport ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/${config.bucket_name}/objects/${target.key}`;
  let response: Response | undefined;
  let phase: "put" | "put_receipt" | "source_completed" | "readback" | "readback_verify" = "put";
  try {
    response = await transport(url, { method: "PUT", body, redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${options.apiToken}`, "Content-Type": target.contentType, "Content-Length": String(target.length) } });
    if (response.status !== 200) throw new Error("Staging REST PUT failed or has an unknown outcome");
    phase = "put_receipt";
    const receipt = await readReceipt(response, target);
    phase = "source_completed";
    requireConsumed();
    phase = "readback";
    response = undefined;
    response = await transport(url, { method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${options.apiToken}`, "Accept-Encoding": "identity" } });
    phase = "readback_verify";
    await verifyResponse(response, target, receipt.etag);
    return receipt;
  } catch {
    console.error(JSON.stringify({ event: "r2_verified_put_failed", phase, reason_code: "put_or_readback_unverified",
      ...(response ? { http_status: response.status } : {}) }));
    throw new Error("Staging REST PUT/verification failed; no automatic retry or remote termination proof");
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (response?.body && !response.body.locked) {
      try { await response.body.cancel(); } catch { throw new Error("Staging REST response cancellation failed; no automatic retry"); }
    }
  }
}
