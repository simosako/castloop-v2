import * as TOML from "@iarna/toml";
import { validateId } from "@castloop/shared";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { AgentError } from "./agent-output";
import { localJournalEntryExists } from "./local-journal-path";
import { readLocalMetadata } from "./local-metadata-read";
import { decodeUtf8Strict } from "./utf8";
import { lstatSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function findWorkspace(start: string): string {
  let directory = resolve(start);
  for (let depth = 0; depth <= 5; depth += 1) {
    if (localJournalEntryExists(join(directory, "castloop.toml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new AgentError("missing_workspace", "No castloop.toml in the current directory or its five parents; specify --workspace PATH.");
}

export async function inferWorkspaceShow(root: string, cwd: string): Promise<string> {
  const name = relative(root, cwd).split(sep)[0];
  if (!name || !localJournalEntryExists(join(root, name, "show.toml"))) {
    throw new AgentError("missing_show", "Specify --show ID or run inside a Show directory in the workspace.");
  }
  const showId = validateId(name, "show"), directory = join(root, showId);
  if (!lstatSync(directory).isDirectory()) throw new AgentError("invalid_directory", "Show directory must be a real directory.");
  const metadata = TOML.parse(decodeUtf8Strict(await readLocalMetadata(join(directory, "show.toml"))));
  if (metadata.show_id !== showId) throw new AgentError("target_mismatch", "Show directory and show.toml identify different Shows.");
  return showId;
}

export function parseSqliteWorkspaceConfigText(source: string): SqliteServiceConfig {
  const value: unknown = TOML.parse(source);
  if (value && typeof value === "object" && "schema_version" in value && value.schema_version === 1) {
    throw new Error("Service schema_version = 1 is not supported in v0.6.0 or later; use a compatible v0.5.x CLI/Worker. Migration is not provided; preserve the workspace and journals");
  }
  if (value && typeof value === "object" && "schema_version" in value && value.schema_version === 2 &&
    (!("storage_layout" in value) || value.storage_layout !== "show-v1")) {
    throw new Error("Service storage_layout = show-v1 is required. Legacy service layouts cannot be updated or migrated; preserve the workspace and use a separate fresh service");
  }
  return sqliteServiceConfigSchema.parse(value);
}

export async function loadWorkspaceConfig(root: string): Promise<SqliteServiceConfig> {
  let source: string;
  try {
    const bytes = await readLocalMetadata(join(root, "castloop.toml"), 16384);
    source = decodeUtf8Strict(bytes);
  } catch (error) {
    throw new Error("Cannot read castloop.toml: expected a stable regular UTF-8 file of 1 to 16384 bytes, not a symbolic link", { cause: error });
  }
  return parseSqliteWorkspaceConfigText(source);
}
