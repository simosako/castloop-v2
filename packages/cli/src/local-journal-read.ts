import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedLocalJournal(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 16384n) throw new Error("Local journal size/type exceeds its record budget");
    const buffer = Buffer.alloc(16385);
    let size = 0;
    for (;;) {
      const length = readSync(fd, buffer, size, buffer.length - size, null);
      if (!length) break;
      size += length;
      if (size > 16384) throw new Error("Local journal grew beyond its record budget");
    }
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Local journal changed during inspection");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size))) as unknown;
  } finally { closeSync(fd); }
}
