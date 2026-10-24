import { parseAdminConfig } from "../../shared/src/admin-config";
import type { AdminConfig } from "../../shared/src/admin-config";
import { readLocalMetadata } from "./local-metadata-read";
import { join } from "node:path";

export async function loadAdminConfig(root: string): Promise<AdminConfig> {
  let bytes: Buffer;
  try { bytes = await readLocalMetadata(join(root, "castloop-admin.toml"), 16384); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema_version: 1 };
    throw new Error("Cannot read castloop-admin.toml: expected a stable regular UTF-8 file of 1 to 16384 bytes, not a symbolic link", { cause: error });
  }
  return parseAdminConfig(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}
