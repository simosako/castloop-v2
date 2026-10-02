import { parseStream } from "music-metadata";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

export async function analyzeAudio(file: string): Promise<{ length: number; duration: number }> {
  if (!file.toLowerCase().endsWith(".mp3")) throw new Error("Audio input must be an MP3 file");
  const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new Error("MP3 input must be a regular file, not a directory or device");
    if (before.size === 0n || before.size > 300_000_000n) {
      throw new Error("MP3 must be nonempty and at most 300,000,000 bytes (rejected before upload)");
    }
    const length = Number(before.size);
    let stopped = false;
    let pending: Promise<unknown> | undefined;
    const stream = Readable.from((async function* () {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (!stopped && position < length) {
        const read = source.read(buffer, 0, Math.min(buffer.length, length - position), position);
        pending = read;
        const { bytesRead } = await read;
        pending = undefined;
        if (!bytesRead || stopped) break;
        position += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    })(), { objectMode: false });
    const settled = finished(stream, { cleanup: true }).catch(() => undefined);
    let format: Awaited<ReturnType<typeof parseStream>>["format"];
    try {
      ({ format } = await parseStream(stream, { mimeType: "audio/mpeg", size: length }, { duration: true, skipCovers: true }));
    } catch {
      throw new Error("Could not parse the MP3 file");
    } finally { stopped = true; stream.destroy(); await settled; await pending; }
    const after = await source.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("MP3 input changed during analysis; inspect the file before staging");
    }
    if (format.container !== "MPEG" || !/^MPEG (?:1|2|2\.5) Layer 3$/.test(format.codec ?? "")) {
      throw new Error("Audio stream must use MP3 encoding");
    }
    const seconds = format.duration;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 ||
      !Number.isSafeInteger(Math.max(1, Math.round(seconds)))) {
      throw new Error("Invalid MP3 duration");
    }
    return { length, duration: Math.max(1, Math.round(seconds)) };
  } finally { await source.close(); }
}
