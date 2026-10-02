import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function readLocalMetadata(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 1000000n) throw new Error("Local publication metadata size/type is invalid");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, 1000001 - size), null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > 1000000) throw new Error("Local publication metadata exceeds its size limit");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Local publication metadata changed during validation");
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
