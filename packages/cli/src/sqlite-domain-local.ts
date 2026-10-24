import { z } from "zod";
import { parseSqliteDomainRequest, sqliteDomainRequestHash } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { ensureLocalJournalParents } from "./local-journal-path";
import { readSqliteDomainJournal } from "./sqlite-domain-journal";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function pendingLocalDomainChanges(root: string, config: SqliteServiceConfig) {
  ensureLocalJournalParents(root, "sqlite-domain-changes", config.service_id);
  let names: string[];
  try { names = readdirSync(join(root, ".castloop", "sqlite-domain-changes", config.service_id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (names.length > 20000) throw new Error("Domain journal inventory exceeds its budget");
  const entries = new Set(names);
  const ids = new Set(names.filter((name) => /\.json(?:\.lock)?$/.test(name)).map((name) => z.uuid().parse(name.replace(/\.json(?:\.lock)?$/, ""))));
  const pending = [];
  for (const operationId of [...ids].sort()) {
    const record = readSqliteDomainJournal(root, config, operationId), lock = entries.has(`${operationId}.json.lock`);
    if (record && (record.request.operation_id !== operationId || record.request.previous_config.service_id !== config.service_id)) throw new Error("Local domain operation identity differs");
    if (!record || record.phase !== "completed" || lock) pending.push({ operation_id: operationId, phase: record?.phase ?? null, lock_present: lock });
  }
  return pending;
}

export async function completedDomainConfiguration(root: string, input: SqliteServiceConfig, hash: string): Promise<SqliteServiceConfig | null> {
  const config = sqliteServiceConfigSchema.parse(input), currentHash = await sqliteServiceConfigHash(config);
  if (hash === currentHash) return config;
  ensureLocalJournalParents(root, "sqlite-domain-changes", config.service_id);
  let files: string[];
  try { files = readdirSync(join(root, ".castloop", "sqlite-domain-changes", config.service_id)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (files.length > 10000) throw new Error("Domain configuration history exceeds its local inspection budget");
  const edges: Array<{ from: string; to: string; config: SqliteServiceConfig }> = [];
  const { public_base_url: _, ...fixed } = config;
  for (const file of files) {
    const journal = readSqliteDomainJournal(root, config, file.slice(0, -5));
    if (!journal || journal.phase !== "completed") continue;
    const request = await parseSqliteDomainRequest(journal.request);
    const { public_base_url: __, ...previousFixed } = request.previous_config;
    if (JSON.stringify(fixed) !== JSON.stringify(previousFixed) || journal.request_sha256 !== await sqliteDomainRequestHash(request)) throw new Error("Completed domain configuration history differs");
    edges.push({ from: request.previous_runtime.service_config_sha256, to: request.target_config_sha256, config: request.previous_config });
  }
  const known = new Set([currentHash]); let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (known.has(edge.to) && !known.has(edge.from)) { known.add(edge.from); changed = true; }
  }
  return known.has(hash) ? edges.find((edge) => edge.from === hash)?.config ?? null : null;
}
