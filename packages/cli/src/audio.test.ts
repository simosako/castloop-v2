import { expect, test } from "bun:test";
import { analyzeAudio } from "./audio";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withAudioFiles(check: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(),
    "castloop-audio-test-"));
  return check(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("reads MP3 frame duration without an external probe", async () => withAudioFiles(async (root) => {
  const file = join(root, "audio.mp3");
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
  writeFileSync(file, Buffer.concat(Array(50).fill(frame)));
  expect(await analyzeAudio(file)).toEqual({ length: 20_850, duration: 1 });
}));

test("rejects non-MP3 data and out-of-range files before upload", async () => withAudioFiles(async (root) => {
  const other = join(root, "audio.mp3");
  writeFileSync(other, "not an MP3");
  await expect(analyzeAudio(other)).rejects.toThrow("MP3 encoding");
  writeFileSync(other, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
  await expect(analyzeAudio(other)).rejects.toThrow("MP3 encoding");
  writeFileSync(other, "");
  await expect(analyzeAudio(other)).rejects.toThrow("nonempty");
  truncateSync(other, 300_000_001);
  await expect(analyzeAudio(other)).rejects.toThrow("300,000,000 bytes");
}));
