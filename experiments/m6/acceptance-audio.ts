import assert from "node:assert/strict";
import { open } from "node:fs/promises";

export async function createAcceptanceMp3(file: string, frames: number, paddingBytes = 0): Promise<{ bytes: number; sha256: string }> {
  assert.ok(Number.isSafeInteger(frames) && frames > 0 && Number.isSafeInteger(paddingBytes) && paddingBytes >= 0 && paddingBytes <= 1024);
  const frame = Buffer.alloc(417);
  frame.set([255, 251, 144, 100]);
  const block = Buffer.concat(Array.from({ length: 1000 }, () => frame));
  const hasher = new Bun.CryptoHasher("sha256");
  const output = await open(file, "wx", 0o600);
  let bytes = 0;
  async function write(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      const result = await output.write(chunk, offset, chunk.length - offset);
      assert.ok(result.bytesWritten > 0);
      offset += result.bytesWritten;
    }
    bytes += chunk.length;
    hasher.update(chunk);
  }
  try {
    if (paddingBytes) {
      const id3 = Buffer.alloc(10 + paddingBytes);
      id3.set([73, 68, 51, 3, 0, 0, 0, 0, paddingBytes >> 7, paddingBytes & 127]);
      await write(id3);
    }
    for (let remaining = frames; remaining > 0; remaining -= 1000) await write(block.subarray(0, Math.min(remaining, 1000) * 417));
    await output.sync();
  } finally { await output.close(); }
  return { bytes, sha256: hasher.digest("hex") };
}
