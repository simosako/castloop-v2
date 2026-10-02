import { expect, test } from "bun:test";
import { analyzeAudio } from "./audio";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("keeps variable-bitrate duration analysis while owning the input descriptor", async () => withAudioFiles(async (root) => {
  const file = join(root, "variable.mp3");
  const low = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
  const high = Buffer.concat([Buffer.from([0xff, 0xfb, 0xe0, 0x64]), Buffer.alloc(1040)]);
  writeFileSync(file, Buffer.concat([low, high, ...Array(8).fill(low), ...Array(90).fill(high)]));
  expect(await analyzeAudio(file)).toEqual({ length: 98757, duration: 3 });
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

test("rejects symlinks, directories and FIFO inputs without following or waiting for data", async () => withAudioFiles(async (root) => {
  const file = join(root, "original.mp3");
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
  writeFileSync(file, Buffer.concat(Array(50).fill(frame)));
  const linked = join(root, "linked.mp3");
  symlinkSync(file, linked);
  await expect(analyzeAudio(linked)).rejects.toThrow();
  const directory = join(root, "directory.mp3");
  mkdirSync(directory);
  await expect(analyzeAudio(directory)).rejects.toThrow("regular file");
  const fifo = join(root, "pipe.mp3");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  await expect(analyzeAudio(fifo)).rejects.toThrow("regular file");
  expect(await analyzeAudio(file)).toEqual({ length: 20850, duration: 1 });
}));
