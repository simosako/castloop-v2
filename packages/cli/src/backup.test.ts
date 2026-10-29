import { describe, expect, test } from "bun:test";
import { stringifyToml } from "@castloop/shared";
import { version } from "../../../package.json";
import { backupEntryFramedBytes, emitBackupEntry, readBackupArchive, sealBackupArchive } from "./backup-archive";
import type { BackupManifest } from "./backup-archive";
import { createLocalBackup } from "./backup-create";
import { previewBackupRestore, restoreLocalBackup, verifyLocalBackup } from "./backup-restore";
import { backupPassphrase } from "./backup-passphrase";
import { administratorKey } from "./administrator-key";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PASSPHRASE = "correct horse battery staple";
const emptyPending = { domain_changes: [] };

function serviceToml(): string {
  return stringifyToml({ schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service",
    account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "test-worker",
    public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" });
}

function backupWorkspace(): string {
  const root = mkdtempSync("/tmp/opencode/castloop-backup-");
  writeFileSync(join(root, "castloop.toml"), serviceToml());
  writeFileSync(join(root, "castloop-admin.toml"), 'schema_version = 1\ntimezone = "Asia/Tokyo"\n');
  writeFileSync(join(root, ".gitignore"), "*.mp3\n");
  mkdirSync(join(root, ".castloop", "sqlite-registrations", "service"), { recursive: true });
  writeFileSync(join(root, ".castloop", "sqlite-registrations", "service", "daily.json"),
    JSON.stringify({ service_config_sha256: "a".repeat(64), show_id: "daily", reservation_id: "11111111-1111-4111-8111-111111111111", phase: "registered" }));
  mkdirSync(join(root, ".castloop", "sqlite-domain-changes", "service"), { recursive: true });
  writeFileSync(join(root, ".castloop", "secrets.json"), JSON.stringify({ CASTLOOP_ADMIN_KEY: "ab".repeat(32) }));
  writeFileSync(join(root, ".castloop", "sqlite-domain-changes", "service", "11111111-1111-4111-8111-111111111111.json.lock"), "");
  writeFileSync(join(root, ".castloop", "sqlite-domain-changes", "service", "pending.json.tmp"), "{}");
  mkdirSync(join(root, ".castloop", "mystery"), { recursive: true });
  writeFileSync(join(root, ".castloop", "mystery", "data.json"), "{}");
  mkdirSync(join(root, "daily"), { recursive: true });
  writeFileSync(join(root, "daily", "show.toml"), `schema_version = 1\nshow_id = "daily"\ntitle = "Daily"\ndescription = "d"\nlanguage = "ja"\nauthor = "a"\nowner_name = "a"\nowner_email = "a@example.com"\nexplicit = false\nsite_mode = "builtin"\n`);
  writeFileSync(join(root, "daily", "episode-first.toml"), "schema_version = 1\n");
  writeFileSync(join(root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  writeFileSync(join(root, "daily", "episode-first.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  writeFileSync(join(root, "notes.txt"), "loose file");
  return root;
}

function craftArchive(output: string, files: Array<{ path: string; kind: string; content: Buffer }>,
  manifestExtra: Partial<BackupManifest> = {}, passphrase = PASSPHRASE): void {
  const serviceId = manifestExtra.service_id ?? "service";
  const includeAudio = manifestExtra.include_audio ?? false;
  const summaries: BackupManifest["entries"] = [];
  const sized = files.map((file) => ({ path: file.path, kind: file.kind, size: file.content.length }));
  sealBackupArchive(output, passphrase, { serviceId, includeAudio, entryCount: files.length,
    entryBytes: sized.reduce((total, file) => total + backupEntryFramedBytes(file), 0) },
    (emit, createdAt) => {
      for (const file of files) {
        const sha256 = emitBackupEntry(emit, { path: file.path, kind: file.kind, size: file.content.length },
          (emitContent) => { if (file.content.length) emitContent(file.content); });
        summaries.push({ path: file.path, size: file.content.length, sha256, kind: file.kind });
      }
      return { schema_version: 1, cli_version: version, created_at: createdAt, service_id: serviceId, include_audio: includeAudio,
        entries: summaries, excluded: [], retained_locks: [], pending: emptyPending, scan_errors: [], ...manifestExtra };
    });
}

describe("backup archive container", () => {
  test("roundtrips entries, digests and the manifest across chunk boundaries", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-unit-");
    try {
      const output = join(directory, "backup.clbk");
      const large = Buffer.concat(Array(1180).fill(Buffer.alloc(4096, 7)));
      craftArchive(output, [
        { path: "castloop.toml", kind: "config", content: Buffer.from(serviceToml()) },
        { path: ".castloop/empty.json", kind: "journal", content: Buffer.alloc(0) },
        { path: "daily/large.mp3", kind: "audio", content: large },
      ], { include_audio: true });
      const read = readBackupArchive(output, PASSPHRASE);
      expect(read.manifest.entries.map((entry) => entry.path)).toEqual(["castloop.toml", ".castloop/empty.json", "daily/large.mp3"]);
      expect(read.entries[2]!.sha256).toBe(createHash("sha256").update(large).digest("hex"));
      expect(read.header.entry_count).toBe(3);
    } finally { rmSync(directory, { recursive: true }); }
  });

  test("rejects a wrong passphrase with one fixed message", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-unit-");
    try {
      const output = join(directory, "backup.clbk");
      craftArchive(output, [{ path: "castloop.toml", kind: "config", content: Buffer.from(serviceToml()) }]);
      expect(() => readBackupArchive(output, "totally different passphrase")).toThrow("Backup passphrase mismatch or archive corruption");
    } finally { rmSync(directory, { recursive: true }); }
  });

  test("detects ciphertext corruption, truncation and trailer damage", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-unit-");
    try {
      const output = join(directory, "backup.clbk");
      craftArchive(output, [{ path: "castloop.toml", kind: "config", content: Buffer.from(serviceToml()) }]);
      const archive = readFileSync(output);
      const middle = Buffer.from(archive);
      middle[Math.floor(middle.length / 2)] ^= 1;
      writeFileSync(join(directory, "corrupt.clbk"), middle);
      expect(() => readBackupArchive(join(directory, "corrupt.clbk"), PASSPHRASE)).toThrow();
      writeFileSync(join(directory, "truncated.clbk"), archive.subarray(0, archive.length - 40));
      expect(() => readBackupArchive(join(directory, "truncated.clbk"), PASSPHRASE)).toThrow("Backup archive ended unexpectedly");
      const trailer = Buffer.from(archive);
      trailer[trailer.length - 1] ^= 1;
      writeFileSync(join(directory, "trailer.clbk"), trailer);
      expect(() => readBackupArchive(join(directory, "trailer.clbk"), PASSPHRASE)).toThrow();
    } finally { rmSync(directory, { recursive: true }); }
  });

  test("rejects unsafe, duplicate and digest-mismatched crafted payloads", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-unit-");
    try {
      craftArchive(join(directory, "unsafe.clbk"), [
        { path: "castloop.toml", kind: "config", content: Buffer.from(serviceToml()) },
        { path: "../evil.txt", kind: "asset", content: Buffer.from("x") },
      ]);
      expect(() => readBackupArchive(join(directory, "unsafe.clbk"), PASSPHRASE)).toThrow("safe relative path");
      craftArchive(join(directory, "absolute.clbk"), [
        { path: "castloop.toml", kind: "config", content: Buffer.from(serviceToml()) },
        { path: "/etc/passwd", kind: "asset", content: Buffer.from("x") },
      ]);
      expect(() => readBackupArchive(join(directory, "absolute.clbk"), PASSPHRASE)).toThrow("safe relative path");
      const config = Buffer.from(serviceToml());
      craftArchive(join(directory, "duplicate.clbk"), [
        { path: "castloop.toml", kind: "config", content: config },
        { path: "castloop.toml", kind: "config", content: config },
      ]);
      expect(() => readBackupArchive(join(directory, "duplicate.clbk"), PASSPHRASE)).toThrow("Duplicate backup entry path");

      const captured: Buffer[] = [];
      emitBackupEntry((chunk) => captured.push(chunk), { path: "castloop.toml", kind: "config", size: config.length },
        (emit) => emit(config));
      captured[2]![40] ^= 1;
      sealBackupArchive(join(directory, "digest.clbk"), PASSPHRASE, { serviceId: "service", includeAudio: false, entryCount: 1,
        entryBytes: backupEntryFramedBytes({ path: "castloop.toml", kind: "config", size: config.length }) },
        (emit, createdAt) => {
          for (const chunk of captured) emit(chunk);
          return { schema_version: 1, cli_version: version, created_at: createdAt, service_id: "service", include_audio: false,
            entries: [{ path: "castloop.toml", size: config.length, sha256: createHash("sha256").update(config).digest("hex"), kind: "config" }],
            excluded: [], retained_locks: [], pending: emptyPending, scan_errors: [] };
        });
      expect(() => readBackupArchive(join(directory, "digest.clbk"), PASSPHRASE)).toThrow("Backup entry digest differs");
    } finally { rmSync(directory, { recursive: true }); }
  });

  test("removes the partial archive when sealing fails", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-unit-");
    try {
      const output = join(directory, "failed.clbk");
      expect(() => sealBackupArchive(output, PASSPHRASE, { serviceId: "service", includeAudio: false, entryCount: 0, entryBytes: 0 },
        () => { throw new Error("body failure"); })).toThrow("body failure");
      expect(existsSync(output)).toBe(false);
    } finally { rmSync(directory, { recursive: true }); }
  });
});

describe("backup create, verify and restore", () => {
  test("creates, verifies, previews and restores a full workspace roundtrip", async () => {
    const root = backupWorkspace();
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-e2e-");
    try {
      const output = join(directory, "backup.clbk");
      const created = await createLocalBackup(root, output, { includeAudio: false, passphrase: PASSPHRASE });
      expect(created.service_id).toBe("service");
      expect(created.entry_count).toBeGreaterThan(5);
      expect(created.excluded_counts.audio_default_excluded).toBe(1);
      expect(created.excluded_counts.lock).toBe(1);
      expect(created.excluded_counts.temporary).toBe(1);
      expect(created.excluded_counts.regenerated).toBe(1);
      expect(created.excluded_counts.unknown).toBeGreaterThanOrEqual(2);
      expect(created.pending.domain_changes).toEqual([]);

      const verified = verifyLocalBackup(output, PASSPHRASE);
      expect(verified.ok).toBe(true);
      expect(verified.config_valid).toBe(true);
      expect(verified.include_audio).toBe(false);
      expect(verified.retained_locks).toEqual([".castloop/sqlite-domain-changes/service/11111111-1111-4111-8111-111111111111.json.lock"]);

      const destination = join(directory, "restored");
      const preview = previewBackupRestore(output, destination, PASSPHRASE);
      expect(preview.destination_exists).toBe(false);
      expect(preview.config_valid).toBe(true);
      expect(preview.entries.some((entry) => entry.path === ".castloop/secrets.json")).toBe(true);
      expect(preview.entries.some((entry) => entry.path === "daily/episode-first.mp3")).toBe(false);

      const restored = restoreLocalBackup(output, destination, PASSPHRASE);
      expect(restored.entry_count).toBe(created.entry_count);
      expect(readFileSync(join(destination, "castloop.toml"), "utf8")).toBe(readFileSync(join(root, "castloop.toml"), "utf8"));
      expect(administratorKey(destination)).toBe("ab".repeat(32));
      expect(readFileSync(join(destination, "daily", "cover.jpg"))).toEqual(readFileSync(join(root, "daily", "cover.jpg")));
      expect(existsSync(join(destination, "daily", "episode-first.mp3"))).toBe(false);
      expect(readFileSync(join(destination, ".gitignore"), "utf8")).toContain(".castloop/");
      expect(previewBackupRestore(output, destination, PASSPHRASE).destination_exists).toBe(true);
      expect(() => restoreLocalBackup(output, destination, PASSPHRASE)).toThrow("must not exist");
    } finally { rmSync(directory, { recursive: true }); rmSync(root, { recursive: true }); }
  });

  test("includes audio originals only with the explicit option", async () => {
    const root = backupWorkspace();
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-e2e-");
    try {
      const output = join(directory, "audio.clbk");
      await createLocalBackup(root, output, { includeAudio: true, passphrase: PASSPHRASE });
      const destination = join(directory, "restored");
      restoreLocalBackup(output, destination, PASSPHRASE);
      expect(readFileSync(join(destination, "daily", "episode-first.mp3"))).toEqual(readFileSync(join(root, "daily", "episode-first.mp3")));
      expect(verifyLocalBackup(output, PASSPHRASE).include_audio).toBe(true);
    } finally { rmSync(directory, { recursive: true }); rmSync(root, { recursive: true }); }
  });

  test("rejects symbolic links inside targets and keeps no partial archive", async () => {
    const root = backupWorkspace();
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-e2e-");
    try {
      writeFileSync(join(root, "daily", "outside.txt"), "outside");
      symlinkSync(join(root, "daily", "outside.txt"), join(root, "daily", "link.txt"));
      const output = join(directory, "backup.clbk");
      await expect(createLocalBackup(root, output, { includeAudio: false, passphrase: PASSPHRASE }))
        .rejects.toThrow("symbolic link");
      expect(existsSync(output)).toBe(false);
    } finally { rmSync(directory, { recursive: true }); rmSync(root, { recursive: true }); }
  });

  test("records scan errors instead of failing when journals are unreadable", async () => {
    const root = backupWorkspace();
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-e2e-");
    try {
      mkdirSync(join(root, ".castloop", "sqlite-domain-changes", "service"), { recursive: true });
      writeFileSync(join(root, ".castloop", "sqlite-domain-changes", "service", "22222222-2222-4222-8222-222222222222.json"), "{invalid");
      const output = join(directory, "backup.clbk");
      const created = await createLocalBackup(root, output, { includeAudio: false, passphrase: PASSPHRASE });
      expect(created.scan_errors).toContain("domain_changes");
      expect(verifyLocalBackup(output, PASSPHRASE).scan_errors).toEqual(["domain_changes"]);
    } finally { rmSync(directory, { recursive: true }); rmSync(root, { recursive: true }); }
  });

  test("restore refuses an invalid archived configuration and leaves no destination", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-e2e-");
    try {
      const output = join(directory, "legacy.clbk");
      craftArchive(output, [{ path: "castloop.toml", kind: "config", content: Buffer.from('schema_version = 1\nservice_id = "service"\n') }]);
      const destination = join(directory, "legacy-restored");
      expect(() => restoreLocalBackup(output, destination, PASSPHRASE)).toThrow("schema_version = 1 is not supported");
      expect(existsSync(destination)).toBe(false);
    } finally { rmSync(directory, { recursive: true }); }
  });

  test("restore removes the partial destination when an entry digest differs mid-stream", () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-e2e-");
    try {
      const output = join(directory, "digest.clbk");
      const config = Buffer.from(serviceToml());
      const secret = Buffer.from(JSON.stringify({ CASTLOOP_ADMIN_KEY: "cd".repeat(32) }));
      const files = [{ path: "castloop.toml", kind: "config", content: config }, { path: ".castloop/secrets.json", kind: "secret", content: secret }];
      const captured: Buffer[][] = [];
      for (const file of files) {
        const parts: Buffer[] = [];
        emitBackupEntry((chunk) => parts.push(chunk), { path: file.path, kind: file.kind, size: file.content.length }, (emit) => emit(file.content));
        captured.push(parts);
      }
      captured[1]![2]![40] ^= 1;
      sealBackupArchive(output, PASSPHRASE, { serviceId: "service", includeAudio: false, entryCount: files.length,
        entryBytes: captured.flat().reduce((total, chunk) => total + chunk.length, 0) },
        (emit, createdAt) => {
          for (const parts of captured) for (const chunk of parts) emit(chunk);
          return { schema_version: 1, cli_version: version, created_at: createdAt, service_id: "service", include_audio: false,
            entries: [
              { path: "castloop.toml", size: config.length, sha256: createHash("sha256").update(config).digest("hex"), kind: "config" },
              { path: ".castloop/secrets.json", size: secret.length, sha256: createHash("sha256").update(secret).digest("hex"), kind: "secret" },
            ], excluded: [], retained_locks: [], pending: emptyPending, scan_errors: [] };
        });
      const destination = join(directory, "partial");
      expect(() => restoreLocalBackup(output, destination, PASSPHRASE)).toThrow("Backup entry digest differs");
      expect(existsSync(destination)).toBe(false);
    } finally { rmSync(directory, { recursive: true }); }
  });
});

describe("backup passphrase input", () => {
  test("reads a passphrase file with its trailing newline stripped and enforces bounds", async () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-pass-");
    try {
      const file = join(directory, "passphrase.txt");
      writeFileSync(file, `${PASSPHRASE}\n`);
      expect(await backupPassphrase({ "passphrase-file": file }, true)).toBe(PASSPHRASE);
      writeFileSync(file, "short\n");
      await expect(backupPassphrase({ "passphrase-file": file }, false)).rejects.toThrow("8 to 1024 bytes");
      await expect(backupPassphrase({}, false)).rejects.toThrow("Missing --passphrase-file");
    } finally { rmSync(directory, { recursive: true }); }
  });
});

describe("backup command entrypoint", () => {
  const entrypoint = join(import.meta.dir, "index.ts");

  test("creates, verifies and restores through the CLI with one JSON envelope each", () => {
    const root = backupWorkspace();
    const directory = mkdtempSync("/tmp/opencode/castloop-backup-cli-");
    try {
      const passphraseFile = join(directory, "passphrase.txt");
      writeFileSync(passphraseFile, `${PASSPHRASE}\n`);
      const output = join(directory, "cli.clbk");
      const created = Bun.spawnSync([process.execPath, entrypoint, "backup-create", "--workspace", root, "--output", output,
        "--passphrase-file", passphraseFile, "--json"], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } });
      expect(created.exitCode).toBe(0);
      const envelope = JSON.parse(created.stdout.toString());
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("backup-create");
      expect(envelope.result.entry_count).toBeGreaterThan(5);
      const verified = Bun.spawnSync([process.execPath, entrypoint, "backup-verify", output, "--passphrase-file", passphraseFile]);
      expect(verified.exitCode).toBe(0);
      expect(verified.stdout.toString()).toContain("Verification: OK");
      const restored = Bun.spawnSync([process.execPath, entrypoint, "backup-restore", output, join(directory, "cli-restored"), "confirm",
        "--passphrase-file", passphraseFile, "--json"], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } });
      expect(restored.exitCode).toBe(0);
      expect(JSON.parse(restored.stdout.toString()).result.entry_count).toBe(envelope.result.entry_count);
      const unconfirmed = Bun.spawnSync([process.execPath, entrypoint, "backup-restore", output, join(directory, "other"), "--json"],
        { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } });
      expect(unconfirmed.exitCode).toBe(1);
      expect(unconfirmed.stdout.toString()).toContain("confirm");
    } finally { rmSync(directory, { recursive: true }); rmSync(root, { recursive: true }); }
  });
});
