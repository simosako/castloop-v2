import { parseFile } from "music-metadata";
import { statSync } from "node:fs";

export async function analyzeAudio(file: string): Promise<{ length: number; duration: number }> {
  if (!file.toLowerCase().endsWith(".mp3")) throw new Error("Audio input must be an MP3 file");
  const length = statSync(file).size;
  if (length === 0 || length > 300_000_000) {
    throw new Error("MP3 must be nonempty and at most 300,000,000 bytes (rejected before upload)");
  }
  let format: Awaited<ReturnType<typeof parseFile>>["format"];
  try {
    ({ format } = await parseFile(file, { duration: true, skipCovers: true }));
  } catch {
    throw new Error("Could not parse the MP3 file");
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
}
