import * as TOML from "@iarna/toml";
import { serviceConfigSchema } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { readLocalMetadata } from "./local-metadata-read";
import { join } from "node:path";

export async function loadWorkspaceConfig(root: string): Promise<ServiceConfig | SqliteServiceConfig> {
  let source: string;
  try {
    const bytes = await readLocalMetadata(join(root, "castloop.toml"), 16384);
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error("Cannot read castloop.toml: expected a stable regular UTF-8 file of 1 to 16384 bytes, not a symbolic link", { cause: error });
  }
  const value: unknown = TOML.parse(source);
  return value && typeof value === "object" && "schema_version" in value && value.schema_version === 2 ?
    sqliteServiceConfigSchema.parse(value) : serviceConfigSchema.parse(value);
}
