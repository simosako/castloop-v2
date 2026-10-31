import { parseAdminConfig } from "../../shared/src/admin-config";
import type { AdminConfig } from "../../shared/src/admin-config";
import { isMissingFileError } from "./local-journal-path";
import { readLocalMetadata } from "./local-metadata-read";
import { decodeUtf8Strict } from "./utf8";
import { join } from "node:path";

export async function loadAdminConfig(root: string): Promise<AdminConfig> {
  let bytes: Buffer;
  try { bytes = await readLocalMetadata(join(root, "castloop-admin.toml"), 16384); }
  catch (error) {
    if (isMissingFileError(error)) return { schema_version: 1 };
    throw new Error("Cannot read castloop-admin.toml: expected a stable regular UTF-8 file of 1 to 16384 bytes, not a symbolic link", { cause: error });
  }
  return parseAdminConfig(decodeUtf8Strict(bytes));
}
