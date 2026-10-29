import { parseEpisodeDraft, parseShowMetadata, episodeDraftInputSchema, showMetadataInputSchema } from "@castloop/shared";
import { parseSqliteServiceConfig } from "../../shared/src/sqlite-service";
import { parseAdminConfig } from "../../shared/src/admin-config";
import { AgentError } from "./agent-output";
import { readLocalMetadata } from "./local-metadata-read";
import { readShowPublicationInput } from "./show-publication-input";
import { analyzeAudio } from "./audio";
import { z } from "zod";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function inspectLocalAsset(path: string, maximumBytes: number): Promise<{ length_bytes: number; sha256: string; prefix: Buffer }> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Local asset input must be a regular file");
    const expected = Number(before.size);
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > maximumBytes) {
      throw new Error("Local asset exceeds its size limit or is empty");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    let prefix = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expected - size + 1), null);
      if (!bytesRead) break;
      if (!size) prefix = Buffer.from(buffer.subarray(0, Math.min(8, bytesRead)));
      size += bytesRead;
      if (size > expected) throw new Error("Local asset grew during inspection");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await source.stat({ bigint: true });
    if (size !== expected || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Local asset changed during inspection");
    }
    return { length_bytes: expected, sha256: hash.digest("hex"), prefix };
  } finally { await source.close(); }
}

export async function loadLocalInput(kind: string, file: string) {
  const bytes = kind === "show" ? await readShowPublicationInput(file) :
    await readLocalMetadata(file, ["service", "admin-config"].includes(kind) ? 16384 : 1000000);
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (kind === "service") return { bytes, value: parseSqliteServiceConfig(source) };
  if (kind === "admin-config") return { bytes, value: parseAdminConfig(source) };
  if (kind === "show") {
    const value = showMetadataInputSchema.parse(parseShowMetadata(source)); return { bytes, value };
  }
  if (kind === "episode") {
    const value = episodeDraftInputSchema.parse(parseEpisodeDraft(source)); return { bytes, value };
  }
  throw new AgentError("invalid_kind", "Choose service, admin-config, show or episode.");
}

export async function inspectCover(file: string) {
  if (!/\.(png|jpg|jpeg)$/i.test(file)) throw new Error("Cover must use a JPEG or PNG extension");
  const png = file.toLowerCase().endsWith(".png");
  const cover = await inspectLocalAsset(file, 5_000_000);
  const signature = png ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from([255, 216, 255]);
  if (!cover.prefix.subarray(0, signature.length).equals(signature)) throw new Error("Local cover signature differs from its extension");
  return { length_bytes: cover.length_bytes, sha256: cover.sha256, extension: png ? "png" as const : "jpg" as const };
}

export async function validateLocalInput(kind: string, file: string, options: { assets?: boolean; audio?: string }) {
  if (!["service", "admin-config", "show", "episode"].includes(kind) || options.assets && kind !== "show" || options.audio && kind !== "episode") {
    throw new AgentError("invalid_options", "Use --assets for show or --audio for episode.");
  }
  try {
    const { value } = await loadLocalInput(kind, file);
    const checks: { id: string; status: string }[] = [{ id: "metadata", status: "pass" }];
    if (kind === "show" && options.assets && "image_path" in value) {
      await inspectCover(resolve(dirname(file), value.image_path)); checks.push({ id: "cover", status: "pass" });
    } else if (kind === "show") checks.push({ id: "cover", status: "not_checked" });
    if (kind === "episode" && options.audio) {
      await inspectLocalAsset(resolve(options.audio), 300_000_000); await analyzeAudio(resolve(options.audio));
      checks.push({ id: "audio", status: "pass" });
    } else if (kind === "episode") checks.push({ id: "audio", status: "not_checked" });
    checks.push({ id: "remote_base_and_readiness", status: "not_checked" });
    return { kind, checks, publication_ready: false };
  } catch (error) {
    const fields = error instanceof z.ZodError ? error.issues.map((issue) => ({
      path: issue.path.filter((item): item is string | number => typeof item === "number" || typeof item === "string" && /^[a-z_]+$/.test(item)), code: issue.code,
    })) : undefined;
    throw new AgentError("invalid_input", "Local input or asset validation failed; inspect field constraints, TOML syntax and file properties.", fields);
  }
}
