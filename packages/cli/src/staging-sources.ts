import { stageAssetSchema, stagePayloadSchema, stageUploadRequestSchema } from "@castloop/shared";
import type { StageAsset, StagePayload, StageUploadRequest } from "@castloop/shared";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

export type FrozenStagingSources = {
  upload: StageUploadRequest;
  assertCurrent: () => Promise<void>;
  withPayload: (index: number, consume: (body: ReadableStream<Uint8Array>, requireConsumed: () => void) => Promise<void>) => Promise<void>;
  dispose: () => Promise<void>;
};

async function checkDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Staging input directory must be private and must not be a symlink");
  }
}

async function checkSource(path: string, expected: StageUploadRequest["payloads"][number], destination?: string): Promise<void> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.length_bytes)) throw new Error("Local staging source size/type differs from its frozen manifest");
    const output = destination ? await open(destination, "wx", 0o600) : undefined;
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let length = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expected.length_bytes - length + 1), null);
        if (!bytesRead) break;
        length += bytesRead;
        if (length > expected.length_bytes) throw new Error("Local staging source grew during validation");
        hash.update(buffer.subarray(0, bytesRead));
        if (output) {
          let offset = 0;
          while (offset < bytesRead) {
            const written = await output.write(buffer, offset, bytesRead - offset, null);
            if (!written.bytesWritten) throw new Error("Staging snapshot write made no progress");
            offset += written.bytesWritten;
          }
        }
      }
      const after = await source.stat({ bigint: true });
      if (length !== expected.length_bytes || hash.digest("hex") !== expected.sha256 || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error("Local staging source changed or differs from its frozen checksum");
      }
      if (output) await output.sync();
    } finally { await output?.close(); }
  } finally { await source.close(); }
}

export async function assertLocalStagingSource(path: string, input: StagePayload): Promise<void> {
  await checkSource(path, stagePayloadSchema.parse(input));
}

export async function inspectLocalStagingSource(path: string, input: StageAsset): Promise<{ payload: StagePayload; prefix: Buffer }> {
  const asset = stageAssetSchema.parse(input);
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Local staging input must be a regular file");
    const candidate = stagePayloadSchema.parse({ asset, length_bytes: Number(before.size), sha256: "0".repeat(64) });
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    let prefix = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, candidate.length_bytes - size + 1), null);
      if (!bytesRead) break;
      if (!size) prefix = Buffer.from(buffer.subarray(0, Math.min(8, bytesRead)));
      size += bytesRead;
      if (size > candidate.length_bytes) throw new Error("Local staging input grew during inspection");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await source.stat({ bigint: true });
    if (size !== candidate.length_bytes || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Local staging input changed during inspection");
    }
    return { payload: { ...candidate, sha256: hash.digest("hex") }, prefix };
  } finally { await source.close(); }
}

export async function freezeStagingSources(root: string, input: StageUploadRequest, paths: readonly string[]): Promise<FrozenStagingSources> {
  const upload = stageUploadRequestSchema.parse(input);
  for (const payload of upload.payloads) Object.freeze(payload);
  Object.freeze(upload.payloads);
  Object.freeze(upload);
  if (paths.length !== upload.payloads.length) throw new Error("Every frozen staging asset requires exactly one local source");
  const originals = paths.map((path) => resolve(root, path));
  const local = join(resolve(root), ".castloop");
  await checkDirectory(local);
  const directory = await mkdtemp(join(local, "upload-inputs-"));
  const snapshots = upload.payloads.map((_, index) => join(directory, String(index)));
  const remove = async () => {
    for (const path of snapshots) {
      try { await unlink(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    await rmdir(directory);
  };
  try {
    for (let index = 0; index < snapshots.length; index += 1) {
      await checkSource(originals[index]!, upload.payloads[index]!, snapshots[index]!);
      await chmod(snapshots[index]!, 0o400);
    }
  } catch (error) { await remove(); throw error; }
  let disposed = false;
  let active = false;
  const used = new Set<number>();
  const exclusively = async (work: () => Promise<void>) => {
    if (disposed || active) throw new Error("Staging source session is closed or still owns active IO");
    active = true;
    try { await work(); } finally { active = false; }
  };
  return {
    upload,
    assertCurrent: () => exclusively(async () => {
      for (let index = 0; index < originals.length; index += 1) await checkSource(originals[index]!, upload.payloads[index]!);
    }),
    withPayload: (index, consume) => exclusively(async () => {
      if (!Number.isInteger(index) || !snapshots[index] || used.has(index)) throw new Error("Staging source cannot be replayed or selected outside its manifest");
      used.add(index);
      await checkSource(originals[index]!, upload.payloads[index]!);
      await checkSource(snapshots[index]!, upload.payloads[index]!);
      const handle = await open(snapshots[index]!, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stream = handle.createReadStream();
      const settled = finished(stream, { cleanup: true }).catch(() => undefined);
      const requireConsumed = () => { if (!stream.readableEnded) throw new Error("PUT responded before its owned source finished"); };
      try {
        await consume(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, requireConsumed);
        requireConsumed();
      } finally { stream.destroy(); await settled; await handle.close(); }
    }),
    dispose: async () => {
      if (active) throw new Error("Cannot remove staging snapshots while source/network IO is active");
      if (disposed) return;
      disposed = true;
      await remove();
    },
  };
}
