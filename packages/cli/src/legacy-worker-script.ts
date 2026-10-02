import { createHash } from "node:crypto";

const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const JAVASCRIPT_TYPES = new Set(["application/javascript", "application/javascript+module", "text/javascript"]);

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SCRIPT_BYTES)) {
    throw new Error("Legacy script download length is invalid");
  }
  if (response.status !== 200 || response.headers.has("Content-Range") || response.redirected || !response.body || response.bodyUsed || response.body.locked) {
    throw new Error("Legacy script download cannot be inspected");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let emptyReads = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SCRIPT_BYTES || !value.byteLength && ++emptyReads > 16) {
        throw new Error("Legacy script download exceeds its inspection budget");
      }
      chunks.push(value);
    }
    if (!length || declared !== null && length !== Number(declared)) throw new Error("Legacy script download is incomplete");
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function moduleHash(response: Response): Promise<string> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const bytes = await boundedBody(response);
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  let module = bytes;
  if (mime === "multipart/form-data") {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
    const entries = [...form.entries()];
    const name = entries[0]?.[0];
    const entry = entries[0]?.[1];
    if (entries.length !== 1 || name !== "index.js" || !(entry instanceof Blob) && typeof entry !== "string" ||
      entry instanceof Blob && !JAVASCRIPT_TYPES.has(entry.type.split(";", 1)[0]!.trim().toLowerCase())) {
      throw new Error("Legacy script must contain exactly one JavaScript module");
    }
    module = typeof entry === "string" ? new TextEncoder().encode(entry) : new Uint8Array(await entry.arrayBuffer());
  } else if (!JAVASCRIPT_TYPES.has(mime)) {
    throw new Error("Legacy script response is not JavaScript");
  }
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(module);
  const scanned = new Bun.Transpiler({ loader: "js" }).scan(source);
  if (scanned.exports.length !== 1 || scanned.exports[0] !== "default" || scanned.imports.length) {
    throw new Error("Legacy script must be a closed default-only JavaScript module");
  }
  return createHash("sha256").update(module).digest("hex");
}

export async function inspectLegacyWorkerScript(response: Response): Promise<string> {
  try {
    try { return await moduleHash(response); }
    finally { if (response.body && !response.body.locked) await response.body.cancel(); }
  } catch { throw new Error("Legacy Worker script inspection failed; no deployment is authorized"); }
}
