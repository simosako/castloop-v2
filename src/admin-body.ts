export async function readBoundedAdminJson(request: Request, maximumBytes = 16384): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid administrator body budget");
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
    throw new Error("Invalid or oversized administrator body length");
  }
  if (!request.body) throw new Error("Missing administrator body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("Administrator body exceeds its budget");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (declared !== null && length !== Number(declared)) throw new Error("Administrator body length differs from its declaration");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}
