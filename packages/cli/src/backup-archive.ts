import { z } from "zod";
import { version } from "../../../package.json";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const BACKUP_FORMAT = "CASTLOOP-BACKUP-1";
export const BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
const BACKUP_READ_BLOCK_BYTES = 1024 * 1024;
const BACKUP_HEADER_LIMIT_BYTES = 4096;
const BACKUP_ENTRY_HEADER_LIMIT_BYTES = 65536;
const BACKUP_MANIFEST_LIMIT_BYTES = 16 * 1024 * 1024;
export const BACKUP_PASSPHRASE_MIN_BYTES = 8;
export const BACKUP_PASSPHRASE_MAX_BYTES = 1024;
export const BACKUP_KDF = { N: 2 ** 15, r: 8, p: 1 } as const;
const BACKUP_DECRYPT_ERROR = "Backup passphrase mismatch or archive corruption";

const headerSchema = z.object({
  format: z.literal("castloop-backup"), version: z.literal(1), cli_version: z.string(),
  created_at: z.string(), service_id: z.string(), include_audio: z.boolean(),
  kdf: z.object({ algo: z.literal("scrypt"), N: z.number().int(), r: z.number().int(), p: z.number().int() }).strict(),
  salt: z.string().regex(/^[a-f0-9]{32}$/), cipher: z.literal("aes-256-gcm"),
  chunk_bytes: z.number().int().min(64 * 1024).max(64 * 1024 * 1024),
  entry_count: z.number().int().min(0), entry_bytes: z.number().int().min(0),
}).strict();

const entrySummarySchema = z.object({ path: z.string(), size: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string().min(1).max(32) }).strict();

const manifestSchema = z.object({
  schema_version: z.literal(1), cli_version: z.string(), created_at: z.string(),
  service_id: z.string(), include_audio: z.boolean(),
  entries: z.array(entrySummarySchema),
  excluded: z.array(z.object({ path: z.string(), reason: z.enum(["lock", "temporary", "regenerated", "audio_default_excluded", "unknown"]) }).strict()),
  retained_locks: z.array(z.string()),
  pending: z.object({
    drafts_staged: z.array(z.string()), drafts_unresolved: z.array(z.string()),
    show_controls: z.number().int().min(0),
    domain_changes: z.array(z.object({ operation_id: z.string(), phase: z.string().nullable(), lock_present: z.boolean() }).strict()),
    service_updates: z.array(z.string()),
  }).strict(),
  source_paths: z.array(z.string()),
  scan_errors: z.array(z.string()),
}).strict();

export type BackupHeader = z.infer<typeof headerSchema>;
export type BackupEntrySummary = z.infer<typeof entrySummarySchema>;
export type BackupManifest = z.infer<typeof manifestSchema>;
export type BackupPending = BackupManifest["pending"];
export type BackupExcludedReason = BackupManifest["excluded"][number]["reason"];
export type BackupSealMeta = { serviceId: string; includeAudio: boolean; entryCount: number; entryBytes: number };
type Sink = (chunk: Buffer) => void;

function assertValidPassphrase(passphrase: string): void {
  const bytes = Buffer.byteLength(passphrase, "utf8");
  if (bytes < BACKUP_PASSPHRASE_MIN_BYTES || bytes > BACKUP_PASSPHRASE_MAX_BYTES) {
    throw new Error(`Backup passphrase must be ${BACKUP_PASSPHRASE_MIN_BYTES} to ${BACKUP_PASSPHRASE_MAX_BYTES} bytes`);
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: BACKUP_KDF.N, r: BACKUP_KDF.r, p: BACKUP_KDF.p, maxmem: 128 * BACKUP_KDF.N * BACKUP_KDF.r * 2 });
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

class ByteQueue {
  private queue: Buffer[] = [];
  private offset = 0;
  length = 0;

  append(chunk: Buffer): void {
    if (!chunk.length) return;
    this.queue.push(chunk);
    this.length += chunk.length;
  }

  take(count: number): Buffer {
    if (count === 0) return Buffer.alloc(0);
    if (this.length < count) throw new Error("Backup byte queue exhausted");
    this.length -= count;
    const head = this.queue[0]!;
    if (head.length - this.offset >= count) {
      const out = head.subarray(this.offset, this.offset + count);
      this.offset += count;
      if (this.offset === head.length) { this.queue.shift(); this.offset = 0; }
      return out;
    }
    const out = Buffer.alloc(count);
    let filled = 0;
    while (filled < count) {
      const current = this.queue[0]!;
      const portion = Math.min(current.length - this.offset, count - filled);
      current.copy(out, filled, this.offset, this.offset + portion);
      this.offset += portion;
      if (this.offset === current.length) { this.queue.shift(); this.offset = 0; }
      filled += portion;
    }
    return out;
  }

  peek(count: number): Buffer {
    const out = Buffer.alloc(count);
    let filled = 0;
    for (const buffer of this.queue) {
      if (filled >= count) break;
      const start = buffer === this.queue[0] ? this.offset : 0;
      const portion = Math.min(buffer.length - start, count - filled);
      buffer.copy(out, filled, start, start + portion);
      filled += portion;
    }
    return out;
  }
}

function recordFrame(type: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(payload.length));
  return Buffer.concat([Buffer.from([type]), length, payload]);
}

function entryHeaderJson(meta: { path: string; kind: string; size: number }): string {
  return JSON.stringify({ path: meta.path, kind: meta.kind, size: meta.size });
}

export function backupEntryFramedBytes(meta: { path: string; kind: string; size: number }): number {
  return 9 + Buffer.byteLength(entryHeaderJson(meta), "utf8") + meta.size + 9 + 32;
}

export function emitBackupEntry(sink: Sink, meta: { path: string; kind: string; size: number },
  content: (emit: (chunk: Buffer) => void) => void): string {
  sink(recordFrame(1, Buffer.from(entryHeaderJson(meta), "utf8")));
  const hash = createHash("sha256");
  let seen = 0;
  content((chunk) => {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) throw new Error("Backup entry content requires non-empty buffers");
    seen += chunk.length;
    if (seen > meta.size) throw new Error(`Backup source grew during archival: ${meta.path}`);
    hash.update(chunk);
    sink(chunk);
  });
  if (seen !== meta.size) throw new Error(`Backup source changed size during archival: ${meta.path}`);
  const digest = hash.digest();
  sink(recordFrame(2, digest));
  return digest.toString("hex");
}

export function emitBackupManifest(sink: Sink, manifest: BackupManifest): void {
  sink(recordFrame(3, Buffer.from(JSON.stringify(manifest), "utf8")));
}

export function sealBackupArchive(output: string, passphrase: string, meta: BackupSealMeta,
  body: (emit: Sink, createdAt: string) => BackupManifest): BackupManifest {
  assertValidPassphrase(passphrase);
  const salt = randomBytes(16), key = deriveKey(passphrase, salt);
  const createdAt = new Date().toISOString();
  const header = headerSchema.parse({ format: "castloop-backup", version: 1, cli_version: version, created_at: createdAt,
    service_id: meta.serviceId, include_audio: meta.includeAudio, kdf: { algo: "scrypt", ...BACKUP_KDF },
    salt: salt.toString("hex"), cipher: "aes-256-gcm", chunk_bytes: BACKUP_CHUNK_BYTES,
    entry_count: meta.entryCount, entry_bytes: meta.entryBytes });
  const fd = openSync(output, "wx", 0o600);
  let sealed = false;
  try {
    writeFull(fd, Buffer.from(`${BACKUP_FORMAT}\n${JSON.stringify(header)}\n`, "utf8"));
    const regionHash = createHash("sha256");
    const pending = new ByteQueue();
    const flush = (bytes: number) => {
      const plaintext = pending.take(bytes);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const frame = recordFrame(0, Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
      regionHash.update(frame);
      writeFull(fd, frame);
    };
    const emit: Sink = (chunk) => {
      pending.append(chunk);
      while (pending.length >= BACKUP_CHUNK_BYTES) flush(BACKUP_CHUNK_BYTES);
    };
    const manifest = manifestSchema.parse(body(emit, createdAt));
    if (manifest.created_at !== createdAt || manifest.cli_version !== version || manifest.service_id !== meta.serviceId ||
      manifest.include_audio !== meta.includeAudio || manifest.entries.length !== meta.entryCount ||
      manifest.entries.reduce((total, entry) => total + backupEntryFramedBytes(entry), 0) !== meta.entryBytes) {
      throw new Error("Backup manifest differs from its sealed entries");
    }
    emitBackupManifest(emit, manifest);
    if (pending.length > 0) flush(pending.length);
    writeFull(fd, regionHash.digest());
    fsyncSync(fd);
    syncLocalJournalDirectory(dirname(output));
    sealed = true;
    return manifest;
  } finally {
    closeSync(fd);
    if (!sealed) { try { unlinkSync(output); } catch { /* the partial archive is already absent */ } }
  }
}

function writeFull(fd: number, buffer: Buffer): void {
  let written = 0;
  while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
}

type EntryBegin = { path: string; kind: string; size: number };
export type BackupContentTarget = { content: (chunk: Buffer) => void; done: () => void };
export type BackupReadSink = (entry: EntryBegin) => BackupContentTarget;

type ParserState = "type" | "entry_length" | "entry_json" | "content" | "digest_type" | "digest_length" |
  "digest" | "manifest_length" | "manifest" | "ended";

class PlaintextParser {
  private queue = new ByteQueue();
  private state: ParserState = "type";
  private entry: EntryBegin | null = null;
  private target: BackupContentTarget | null = null;
  private remaining = 0;
  private recordLength = 0;
  private hash = createHash("sha256");
  private seenPaths = new Set<string>();
  private manifest: BackupManifest | null = null;
  readonly entries: BackupEntrySummary[] = [];

  constructor(private readonly sink: BackupReadSink | undefined) {}

  feed(chunk: Buffer): void {
    this.queue.append(chunk);
    for (;;) {
      if (this.state === "ended") {
        if (this.queue.length) throw new Error("Backup archive has trailing records");
        return;
      }
      if (this.state === "content") {
        if (this.remaining === 0) { this.state = "digest_type"; continue; }
        if (!this.queue.length) return;
        const portion = this.queue.take(Math.min(this.remaining, this.queue.length));
        this.remaining -= portion.length;
        this.hash.update(portion);
        this.target?.content(portion);
        if (this.remaining === 0) this.state = "digest_type";
        continue;
      }
      if (this.queue.length < this.expected()) return;
      this.step();
    }
  }

  private expected(): number {
    if (this.state === "type" || this.state === "digest_type") return 1;
    if (this.state === "entry_length" || this.state === "digest_length" || this.state === "manifest_length") return 8;
    return this.recordLength;
  }

  private step(): void {
    if (this.state === "type") {
      const type = this.queue.take(1)[0]!;
      if (type === 1) this.state = "entry_length";
      else if (type === 3) this.state = "manifest_length";
      else throw new Error("Unsupported backup record type");
      return;
    }
    if (this.state === "entry_length") {
      this.recordLength = Number(this.queue.take(8).readBigUInt64BE(0));
      if (this.recordLength < 2 || this.recordLength > BACKUP_ENTRY_HEADER_LIMIT_BYTES) throw new Error("Backup entry header size is out of range");
      this.state = "entry_json";
      return;
    }
    if (this.state === "entry_json") {
      const entry = z.object({ path: z.string().min(1).max(1024), kind: z.string().min(1).max(32), size: z.number().int().min(0) })
        .strict().parse(JSON.parse(decodeUtf8(this.queue.take(this.recordLength))));
      assertSafeEntryPath(entry.path);
      if (this.seenPaths.has(entry.path)) throw new Error("Duplicate backup entry path");
      this.seenPaths.add(entry.path);
      this.entry = entry;
      this.target = this.sink ? this.sink(entry) : null;
      this.hash = createHash("sha256");
      this.remaining = entry.size;
      this.state = "content";
      return;
    }
    if (this.state === "digest_type") {
      const type = this.queue.take(1)[0]!;
      if (type !== 2) throw new Error("Expected the backup entry digest record");
      this.state = "digest_length";
      return;
    }
    if (this.state === "digest_length") {
      const length = Number(this.queue.take(8).readBigUInt64BE(0));
      if (length !== 32) throw new Error("Backup entry digest size differs");
      this.recordLength = 32;
      this.state = "digest";
      return;
    }
    if (this.state === "digest") {
      const digest = this.queue.take(this.recordLength);
      if (!this.entry) throw new Error("Backup parser lost its entry");
      if (!digest.equals(this.hash.digest())) throw new Error(`Backup entry digest differs: ${this.entry.path}`);
      this.target?.done();
      this.entries.push({ ...this.entry, sha256: digest.toString("hex") });
      this.entry = null;
      this.target = null;
      this.state = "type";
      return;
    }
    if (this.state === "manifest_length") {
      this.recordLength = Number(this.queue.take(8).readBigUInt64BE(0));
      if (this.recordLength < 2 || this.recordLength > BACKUP_MANIFEST_LIMIT_BYTES) throw new Error("Backup manifest size is out of range");
      this.state = "manifest";
      return;
    }
    if (this.state === "manifest") {
      this.manifest = manifestSchema.parse(JSON.parse(decodeUtf8(this.queue.take(this.recordLength))));
      this.state = "ended";
      return;
    }
    throw new Error("Backup parser reached an impossible state");
  }

  finish(header: BackupHeader): BackupManifest {
    if (this.state !== "ended" || this.queue.length || !this.manifest) throw new Error("Backup archive ended unexpectedly");
    const manifest = this.manifest;
    if (manifest.entries.length !== this.entries.length || manifest.entries.length !== header.entry_count ||
      manifest.entries.some((entry, index) => entry.path !== this.entries[index]!.path || entry.size !== this.entries[index]!.size ||
        entry.sha256 !== this.entries[index]!.sha256 || entry.kind !== this.entries[index]!.kind)) {
      throw new Error("Backup manifest differs from its decrypted entries");
    }
    if (this.entries.reduce((total, entry) => total + backupEntryFramedBytes(entry), 0) !== header.entry_bytes) {
      throw new Error("Backup header byte count differs from its entries");
    }
    return manifest;
  }
}

function assertSafeEntryPath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part.length || part === "." || part === "..")) {
    throw new Error("Backup entry path must be a safe relative path");
  }
}

export function readBackupArchive(file: string, passphrase: string, sink?: BackupReadSink):
  { header: BackupHeader; entries: BackupEntrySummary[]; manifest: BackupManifest } {
  assertValidPassphrase(passphrase);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const total = fstatSync(fd).size;
    if (total <= 32) throw new Error("Backup archive is truncated");
    const headBuffer = Buffer.alloc(Math.min(total - 32, 2 * BACKUP_HEADER_LIMIT_BYTES));
    const head = headBuffer.subarray(0, readInto(fd, headBuffer, headBuffer.length, 0));
    const firstLine = head.indexOf("\n");
    if (firstLine < 0 || decodeUtf8(head.subarray(0, firstLine)) !== BACKUP_FORMAT) throw new Error("Unsupported backup archive format");
    const secondLine = head.indexOf("\n", firstLine + 1);
    if (secondLine < 0 || secondLine > BACKUP_HEADER_LIMIT_BYTES) throw new Error("Backup archive header exceeds its limit");
    const header = headerSchema.parse(JSON.parse(decodeUtf8(head.subarray(firstLine + 1, secondLine))));
    if (header.kdf.N !== BACKUP_KDF.N || header.kdf.r !== BACKUP_KDF.r || header.kdf.p !== BACKUP_KDF.p || header.cipher !== "aes-256-gcm") {
      throw new Error("Unsupported backup KDF or cipher parameters");
    }
    const key = deriveKey(passphrase, Buffer.from(header.salt, "hex"));
    const regionEnd = total - 32;
    let position = secondLine + 1;
    if (position > regionEnd) throw new Error("Backup archive is truncated");
    const regionHash = createHash("sha256");
    const parser = new PlaintextParser(sink);
    const frames = new ByteQueue();
    const block = Buffer.alloc(BACKUP_READ_BLOCK_BYTES);
    while (position < regionEnd) {
      const read = readInto(fd, block, Math.min(block.length, regionEnd - position), position);
      if (read === 0) throw new Error("Backup archive ended unexpectedly");
      position += read;
      const bytes = Buffer.from(block.subarray(0, read));
      regionHash.update(bytes);
      frames.append(bytes);
      drainFrames(frames, key, header, parser);
    }
    if (frames.length !== 0) throw new Error("Backup archive ended unexpectedly");
    const trailer = block.subarray(0, readInto(fd, block, 32, regionEnd));
    if (trailer.length !== 32 || !trailer.equals(regionHash.digest())) throw new Error("Backup archive trailer differs from its ciphertext");
    return { header, entries: parser.entries, manifest: parser.finish(header) };
  } finally {
    closeSync(fd);
  }
}

function drainFrames(frames: ByteQueue, key: Buffer, header: BackupHeader, parser: PlaintextParser): void {
  for (;;) {
    if (frames.length < 9) return;
    const prefix = frames.peek(9);
    if (prefix[0] !== 0) throw new Error("Backup chunk framing differs");
    const payloadLength = Number(prefix.readBigUInt64BE(1));
    const plaintextLength = payloadLength - 12 - 16;
    if (plaintextLength < 1 || plaintextLength > header.chunk_bytes) throw new Error("Backup chunk length is out of range");
    if (frames.length < 9 + payloadLength) return;
    frames.take(9);
    const nonce = frames.take(12);
    const payload = frames.take(plaintextLength + 16);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(payload.subarray(plaintextLength));
      plaintext = Buffer.concat([decipher.update(payload.subarray(0, plaintextLength)), decipher.final()]);
    } catch {
      throw new Error(BACKUP_DECRYPT_ERROR);
    }
    parser.feed(plaintext);
  }
}

function readInto(fd: number, buffer: Buffer, length: number, position: number): number {
  let size = 0;
  while (size < length) {
    const read = readSync(fd, buffer, size, length - size, position + size);
    if (!read) break;
    size += read;
  }
  return size;
}
