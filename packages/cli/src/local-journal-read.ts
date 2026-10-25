import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedLocalJournal(file: string, maximum = 16384): unknown {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8_388_608) throw new Error("Invalid local JSON read budget");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) throw new Error("Local journal size/type exceeds its record budget");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    for (;;) {
      const length = readSync(fd, buffer, size, buffer.length - size, null);
      if (!length) break;
      size += length;
      if (size > Number(before.size)) throw new Error("Local journal grew beyond its record budget");
    }
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Local journal changed during inspection");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size))) as unknown;
  } finally { closeSync(fd); }
}
