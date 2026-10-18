import * as TOML from "@iarna/toml";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { readLocalMetadata } from "./local-metadata-read";
import { join } from "node:path";

export async function loadWorkspaceConfig(root: string): Promise<SqliteServiceConfig> {
  let source: string;
  try {
    const bytes = await readLocalMetadata(join(root, "castloop.toml"), 16384);
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error("Cannot read castloop.toml: expected a stable regular UTF-8 file of 1 to 16384 bytes, not a symbolic link", { cause: error });
  }
  const value: unknown = TOML.parse(source);
  if (value && typeof value === "object" && "schema_version" in value && value.schema_version === 1) {
    throw new Error("Service schema_version = 1 is not supported in v0.6.0 or later; use a compatible v0.5.x CLI/Worker. Migration is not provided; preserve the workspace and journals");
  }
  return sqliteServiceConfigSchema.parse(value);
}
