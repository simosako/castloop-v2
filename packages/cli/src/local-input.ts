import { parseEpisodeDraft, parseShowMetadata, episodeDraftInputSchema, showMetadataInputSchema } from "@castloop/shared";
import { parseSqliteServiceConfig } from "../../shared/src/sqlite-service";
import { parseAdminConfig } from "../../shared/src/admin-config";
import { AgentError } from "./agent-output";
import { readLocalMetadata } from "./local-metadata-read";
import { analyzeAudio } from "./audio";
import { inspectLocalStagingSource } from "./staging-sources";
import { z } from "zod";
import { dirname, resolve } from "node:path";

export async function loadLocalInput(kind: string, file: string) {
  const bytes = await readLocalMetadata(file, ["service", "admin-config"].includes(kind) ? 16384 : 1000000);
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
  const asset = file.toLowerCase().endsWith(".png") ? "cover_png" : "cover_jpg";
  const cover = await inspectLocalStagingSource(file, asset);
  const signature = asset === "cover_png" ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from([255, 216, 255]);
  if (!cover.prefix.subarray(0, signature.length).equals(signature)) throw new Error("Local cover signature differs from its extension");
  return cover.payload;
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
      await inspectLocalStagingSource(resolve(options.audio), "audio"); await analyzeAudio(resolve(options.audio));
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
