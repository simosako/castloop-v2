import * as TOML from "@iarna/toml";
import { serviceConfigSchema } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadWorkspaceConfig(root: string): ServiceConfig | SqliteServiceConfig {
  const value: unknown = TOML.parse(readFileSync(join(root, "castloop.toml"), "utf8"));
  return value && typeof value === "object" && "schema_version" in value && value.schema_version === 2 ?
    sqliteServiceConfigSchema.parse(value) : serviceConfigSchema.parse(value);
}
