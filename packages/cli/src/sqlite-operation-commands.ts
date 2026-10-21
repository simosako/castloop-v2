import { z } from "zod";
import { sqliteServiceConfigSchema } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import { operationCommandSchema } from "../../shared/src/sqlite-operations";
import { administratorKey } from "./administrator-key";
import { createLocalJournalStorage } from "./local-journal-storage";
import { ensureLocalJournalParents, localJournalEntryExists } from "./local-journal-path";
import type { JournalFamily } from "./local-journal-path";
import { SqliteOperationClient } from "./sqlite-operation-client";
import { readSqliteUploadRecord } from "./sqlite-upload";
import { SqliteDraft } from "./sqlite-draft";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const families = { upload: "sqlite-uploads", draft: "sqlite-drafts", publication: "sqlite-publications",
  "rss-import": "sqlite-rss-imports", "show-registration": "sqlite-registrations", lifecycle: "sqlite-lifecycle", cleanup: "sqlite-operation-requests" } as const;
export type OperationReadOptions = { showId?: string; local?: boolean; incomplete?: boolean; cursor?: string; parent?: string;
  afterVersion?: number; requestCursor?: string };
const briefSchema = z.object({ schema_version: z.number().optional(), operation_id: z.uuid().optional(), import_id: z.uuid().optional(),
  job_id: z.uuid().optional(), phase: z.string().optional(), state: z.string().optional(), step: z.number().optional(),
  target: z.object({ job_id: z.uuid(), kind: z.enum(["show", "episode"]), show_id: z.string(), episode_id: z.string().optional() }).optional(),
  publication: z.object({ status: z.object({ state: z.string() }).optional() }).optional(),
  intents: z.array(z.object({ upload_id: z.uuid(), state: z.string().optional() })).optional(),
  command: z.object({ operation_id: z.uuid(), action: z.string() }).optional(),
  result: z.object({ operation: z.object({ state: z.string() }) }).optional(),
});

function localRecords(root: string, config: SqliteServiceConfig) {
  const result: Array<{ family: string; id: string; format: number | null; state: string; step: number | null;
    show_id: string | null; episode_id: string | null; legacy_lock_present: boolean; uploads: Array<{ upload_id: string; state?: string }> }> = [];
  for (const [name, family] of Object.entries(families)) {
    ensureLocalJournalParents(root, family, config.service_id);
    let names: string[];
    try { names = readdirSync(join(root, ".castloop", family, config.service_id)).filter((entry) => entry.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (names.length + result.length > 10000) throw new Error("Local operation lookup exceeds its record budget");
    for (const file of names) {
      const storage = createLocalJournalStorage(root, family as JournalFamily, config.service_id, file), brief = briefSchema.parse(storage.read());
      if (name === "cleanup" && brief.command?.action !== "cleanup") continue;
      result.push({ family: name, id: brief.operation_id ?? brief.import_id ?? brief.target?.job_id ?? brief.job_id ?? brief.command?.operation_id ?? file.slice(0, -5),
        format: brief.schema_version ?? null, state: brief.result?.operation.state ?? brief.publication?.status?.state ?? brief.state ?? brief.phase ??
          (brief.intents?.length ? brief.intents.map((asset) => asset.state ?? "unknown").join(",") : "draft"), step: brief.step ?? null,
        show_id: brief.target?.show_id ?? null, episode_id: brief.target?.episode_id ?? null,
        legacy_lock_present: localJournalEntryExists(`${storage.path}.lock`), uploads: brief.intents ?? [] });
    }
  }
  return result;
}

export async function runSqliteOperationCommand(root: string, input: SqliteServiceConfig, command: string, args: string[],
  options: OperationReadOptions = {}, transport?: R2RestTransport, r2?: R2RestOptions): Promise<unknown> {
  const config = sqliteServiceConfigSchema.parse(input);
  if (options.local) {
    if (!["operation-list", "operation-status"].includes(command)) throw new Error("--local is only for read-only operation diagnosis");
    const records = localRecords(root, config);
    if (command === "operation-list") return { source: "local", operations: options.incomplete ? records.filter((record) =>
      !["succeeded", "failed", "cancelled", "completed", "attached", "attached,attached"].includes(record.state)) : records };
    if (!Object.hasOwn(families, args[0]!)) throw new Error("Unknown operation family");
    return { source: "local", operations: records.filter((record) => record.family === args[0] && record.id === args[1]) };
  }
  if (!options.showId) throw new Error("Remote operation commands require --show SHOW_ID");
  const key = administratorKey(root), client = new SqliteOperationClient(config, key, transport, options.showId);
  if (command === "operation-list") return client.list(options);
  const id = z.uuid().parse(args[1]);
  if (!Object.hasOwn(families, args[0]!)) throw new Error("Unknown operation family");
  if (command === "operation-status") {
    const detail = await client.detail(id, options.afterVersion, options.requestCursor, args[0] === "rss-import");
    if (!detail) return { operation_id: id, remote: null, message: "サーバーに記録がありません。旧形式の操作は --local で確認してください。" };
    const expectedKinds: Record<string, string> = { upload: "upload", "rss-import": "rss_import", publication: "publication", draft: "publication",
      "show-registration": "show_registration", lifecycle: "publication", cleanup: "cleanup" };
    const expectedKind = expectedKinds[args[0]!];
    if (detail.operation.kind !== expectedKind && !(args[0] === "upload" && detail.operation.kind === "cleanup")) throw new Error("Operation family differs");
    const unknown = detail.assets.some((asset) => ["put_requested", "unknown"].includes(asset.upload_state));
    return { ...detail, ...(args[0] === "rss-import" ? { progress: {
      published_episode_count: detail.related_summary.filter((entry) => entry.kind === "publication" && entry.target_kind === "episode" && entry.state === "succeeded")
        .reduce((count, entry) => count + entry.count, 0),
      unstarted_episode_count: null,
    } } : {}), guidance: detail.operation.kind === "cleanup" && detail.operation.state !== "succeeded" ?
      "削除の完了を確認できていないファイルがあります。対象を保持し、削除要求は再送しません。" :
      unknown ? "アップロードの成功応答が必要です。結果不明のPUTは再送しません。" :
      detail.operation.state === "cancelled" ? "取消済みです。不要な素材は operation-cleanup-preview で確認できます。" :
        detail.operation.state === "succeeded" ? "この操作は完了しています。" : "手元の記録も --local で確認し、成功が記録された段階から再開してください。" };
  }
  if (command === "operation-resume" && args[0] === "upload") {
    const upload = await readSqliteUploadRecord(root, config, id);
    if (upload.target.show_id !== options.showId) throw new Error("Upload resume Show differs from --show");
    const draft = await SqliteDraft.open(root, config, upload.target, { administratorKey: key, managementTransport: transport, r2 });
    return draft.resumeUpload(id);
  }
  if (command === "operation-cancel") return client.change(root, id, "cancel");
  if (command === "operation-cleanup-preview" && args[0] === "upload") return client.cleanupPlan(id);
  if (command === "operation-cleanup" && args[0] === "upload" && args[3] === "confirm") {
    const plan = await client.cleanupPlan(id);
    if (plan.plan_sha256 !== args[2]) throw new Error("Cleanup confirmation hash differs from the current preview");
    return client.send(root, operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id,
      worker_version_id: plan.worker_version_id, service_config_sha256: plan.service_config_sha256,
      operation_id: crypto.randomUUID(), request_id: crypto.randomUUID(), expected_version: 0, action: "cleanup",
      cleanup: { source_operation_id: id, source_version: plan.source_version, plan_sha256: plan.plan_sha256 } }));
  }
  throw new Error("Unsupported operation command or family");
}
