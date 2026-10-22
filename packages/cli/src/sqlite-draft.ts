import { z } from "zod";
import { assertEpisodeDraftInputLimits, assertShowMetadataInputLimits, parseEpisodeDraft, parseShowMetadata, parseSqlitePublicationRequest, sqlitePublicationRequestHash,
  sqliteServiceConfigSchema, sqliteVerifiedUploadSchema } from "@castloop/shared";
import type { EpisodeDraft, ShowMetadata, SqlitePublicationStatus, SqliteServiceConfig, StagePayload } from "@castloop/shared";
import { analyzeAudio } from "./audio";
import { openSqliteDraftJournal, requireSqliteStatus, sqliteDraftAssetSchema } from "./sqlite-draft-journal";
import type { SqliteDraftJournal, SqliteDraftRecord, SqliteDraftTarget } from "./sqlite-draft-journal";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import type { SqliteManagementReadBudget } from "./sqlite-management-http";
import { attachSqliteUpload, readSqliteUploadRecord, requireNoPendingSqliteUpload, resumeSqliteUpload, uploadSqliteDraftAssets } from "./sqlite-upload";
import { SqliteOperationClient, sqliteClientIdentity } from "./sqlite-operation-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import { assertLocalStagingSource, inspectLocalStagingSource } from "./staging-sources";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";
import { sha256HexSync as sha256 } from "./sha256";
import { loadLocalInput, inspectCover } from "./local-input";
import { draftPreview } from "./draft-preview";
import { AgentError } from "./agent-output";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

const selectionSchema = z.discriminatedUnion("asset", [z.object({ asset: z.literal("show") }).strict(),
  z.object({ asset: z.literal("episode_metadata") }).strict(),
  z.object({ asset: z.literal("audio"), audio_path: z.string().min(1).max(2048) }).strict()]);
export type SqliteDraftSelection = z.infer<typeof selectionSchema>;
export type SqliteDraftOptions = { administratorKey: string; managementTransport?: R2RestTransport; r2?: R2RestOptions;
  parentOperationId?: string; importId?: string; onUploadPrepared?: (id: string) => void };

function sameAssetSlot(left: StagePayload["asset"], right: StagePayload["asset"]): boolean {
  return left === right || left.startsWith("cover_") && right.startsWith("cover_");
}

export class SqliteDraft {
  private constructor(private readonly root: string, private readonly config: SqliteServiceConfig,
    private readonly journal: SqliteDraftJournal, private readonly client: SqlitePublicationClient,
    private readonly r2: R2RestOptions, private readonly operations: SqliteOperationClient,
    private readonly service: SqliteServiceClient, private readonly context: Pick<SqliteDraftOptions, "parentOperationId" | "importId" | "onUploadPrepared">) {}

  static async open(root: string, input: SqliteServiceConfig, target: SqliteDraftTarget,
    options: SqliteDraftOptions): Promise<SqliteDraft> {
    const config = sqliteServiceConfigSchema.parse(input);
    const client = new SqlitePublicationClient(config, options.administratorKey, options.managementTransport);
    return new SqliteDraft(resolve(root), config, await openSqliteDraftJournal(root, config, target), client, options.r2 ?? {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" },
    new SqliteOperationClient(config, options.administratorKey, options.managementTransport, target.show_id),
    new SqliteServiceClient(config, options.administratorKey, options.managementTransport),
    { parentOperationId: options.parentOperationId, importId: options.importId, onUploadPrepared: options.onUploadPrepared });
  }

  read(): Promise<SqliteDraftRecord> { return this.journal.load(); }

  private metadataPath(record: SqliteDraftRecord): string {
    return join(this.root, record.target.show_id, record.target.kind === "show" ? "show.toml" : `episode-${record.target.episode_id}.toml`);
  }

  private async metadata(record: SqliteDraftRecord): Promise<Buffer> {
    for (const path of [this.root, join(this.root, record.target.show_id)]) {
      if (!(await lstat(path)).isDirectory()) throw new Error("SQLite local content parents must be real directories, not symlinks");
    }
    const { bytes, value } = await loadLocalInput(record.target.kind, this.metadataPath(record));
    if (record.target.kind === "show") {
      const show = value as ShowMetadata;
      if (show.show_id !== record.target.show_id) throw new Error("SQLite metadata targets another Show");
      assertShowMetadataInputLimits(show);
    } else {
      const episode = value as EpisodeDraft;
      if (episode.episode_id !== record.target.episode_id) throw new Error("SQLite metadata targets another Episode");
      assertEpisodeDraftInputLimits(episode);
    }
    return bytes;
  }

  private requireUnchangedMetadata(record: SqliteDraftRecord, bytes: Buffer): void {
    if (record.target.kind === "show") return;
    const staged = record.assets.find((entry) => entry.upload.asset === "episode_metadata");
    if (staged ? sha256(bytes) !== staged.upload.sha256 : record.target.base_revision_id !== undefined &&
      sha256(JSON.stringify(parseEpisodeDraft(bytes.toString("utf8")))) !== record.target.base_metadata_sha256) {
      throw new Error("Local Episode metadata differs from the staged or published base; stage the current metadata explicitly");
    }
  }

  async stage(selectionInput: SqliteDraftSelection): Promise<SqliteDraftRecord> {
    const selection = selectionSchema.parse(selectionInput);
    return this.journal.storage.exclusively(async () => {
      const record = await this.journal.load();
      if (record.publication) throw new Error("SQLite publication was requested; its draft and upload references are frozen");
      if ((selection.asset === "show") !== (record.target.kind === "show")) throw new Error("SQLite staging selection differs from its target");
      const metadata = await this.metadata(record), metadataPath = this.metadataPath(record);
      const payloads: StagePayload[] = [], paths: string[] = [];
      let duration: number | undefined;
      if (selection.asset === "show") {
        const show = parseShowMetadata(metadata.toString("utf8"));
        const path = join(this.root, record.target.show_id, show.image_path);
        const cover = await inspectCover(path);
        payloads.push({ asset: "show_metadata", length_bytes: metadata.length, sha256: sha256(metadata) }, cover);
        paths.push(metadataPath, path);
      } else if (selection.asset === "episode_metadata") {
        payloads.push({ asset: "episode_metadata", length_bytes: metadata.length, sha256: sha256(metadata) });
        paths.push(metadataPath);
      } else {
        this.requireUnchangedMetadata(record, metadata);
        const path = resolve(this.root, record.target.show_id, selection.audio_path);
        const audio = await inspectLocalStagingSource(path, "audio");
        const analysis = await analyzeAudio(path);
        if (analysis.length !== audio.payload.length_bytes) throw new Error("Local MP3 changed during analysis");
        duration = analysis.duration;
        payloads.push(audio.payload);
        paths.push(path);
      }
      await requireNoPendingSqliteUpload(this.root, this.config, record.target, this.operations);
      const uploaded = await uploadSqliteDraftAssets(this.root, this.config, record.target, payloads, paths, duration, this.r2,
        { client: this.operations, service: this.service, metadataSha256: sha256(metadata), baseAssets: record.assets, ...this.context });
      if (!metadata.equals(await this.metadata(record))) throw new Error("Local metadata changed while its upload was in progress");
      const assets = record.assets.filter((entry) => !uploaded.assets.some((next) => sameAssetSlot(next.upload.asset, entry.upload.asset)));
      const next = { ...record, assets: [...assets, ...uploaded.assets] };
      this.journal.replace(next);
      await attachSqliteUpload(this.root, this.config, uploaded.operationId, this.operations);
      return this.journal.load();
    });
  }

  async resumeUpload(id: string): Promise<SqliteDraftRecord> {
    return this.journal.storage.exclusively(async () => {
      const record = await this.journal.load(), upload = await readSqliteUploadRecord(this.root, this.config, id);
      if (record.schema_version !== 2 || record.publication || JSON.stringify(record.target) !== JSON.stringify(upload.target) ||
        sha256(await this.metadata(record)) !== upload.metadata_sha256) throw new Error("Upload resume requires its unchanged, unfrozen draft and metadata");
      const previouslyUploaded = upload.intents.every((intent) => intent.receipt) ? upload.intents.map(({ source_path, state, receipt, ...intent }) =>
        sqliteDraftAssetSchema.parse({ source_path, upload: sqliteVerifiedUploadSchema.parse({ ...intent, ...receipt, verified: true }) })) : null;
      const kept = upload.base_assets.filter((entry) => !upload.intents.some((intent) => sameAssetSlot(intent.asset, entry.upload.asset)));
      if (JSON.stringify(record.assets) !== JSON.stringify(upload.base_assets) &&
        (!previouslyUploaded || JSON.stringify(record.assets) !== JSON.stringify([...kept, ...previouslyUploaded]))) {
        throw new Error("Another operation changed this draft; do not resume its upload");
      }
      const result = await resumeSqliteUpload(this.root, this.config, id, this.r2, this.operations);
      if (sha256(await this.metadata(record)) !== upload.metadata_sha256) throw new Error("Metadata changed during upload verification");
      const assets = upload.base_assets.filter((entry) => !result.assets.some((next) => sameAssetSlot(next.upload.asset, entry.upload.asset)));
      const merged = [...assets, ...result.assets.map((entry) => sqliteDraftAssetSchema.parse(entry))];
      if (JSON.stringify(record.assets) !== JSON.stringify(upload.base_assets) && JSON.stringify(record.assets) !== JSON.stringify(merged)) {
        throw new Error("A different upload changed this draft; do not overwrite its references");
      }
      this.journal.replace({ ...record, assets: merged });
      await attachSqliteUpload(this.root, this.config, id, this.operations);
      return this.journal.load();
    });
  }

  private async retainStatus(record: SqliteDraftRecord, status: SqlitePublicationStatus): Promise<SqlitePublicationStatus> {
    const publication = record.publication!;
    requireSqliteStatus(publication.request, publication.request_sha256, status, publication.status);
    this.journal.replace({ ...record, publication: { ...publication, status } });
    return status;
  }

  private async observeRecord(record: SqliteDraftRecord, budget: SqliteManagementReadBudget = {}): Promise<SqlitePublicationStatus | null> {
    if (!record.publication) throw new Error("SQLite draft has no frozen publication request");
    const status = await this.client.observe(record.publication.request, budget);
    if (status === null && record.publication.status) throw new Error("Previously acknowledged SQLite publication is missing; keep its retained result");
    return status ? this.retainStatus(record, status) : null;
  }

  observe(budget: SqliteManagementReadBudget = {}): Promise<SqlitePublicationStatus | null> {
    return this.journal.storage.exclusively(async () => this.observeRecord(await this.journal.load(), budget));
  }

  publish(expectedPreview?: string): Promise<SqlitePublicationStatus | null> {
    return this.journal.storage.exclusively(async () => {
      const record = await this.journal.load();
      if (record.publication) return this.observeRecord(record);
      const checkPreview = async () => {
        if (!expectedPreview) return;
        const preview = await draftPreview(this.root, this.config, record.target, record);
        if (preview.input_fingerprint !== expectedPreview || !preview.inputs_match_staged) {
          throw new AgentError("preview_changed", "Reviewed inputs differ; preview and obtain approval again before publication.");
        }
      };
      await checkPreview();
      const service = await this.client.describe(record.target.show_id);
      if (service.state !== "open") throw new Error("SQLite publication admission is paused");
      const metadata = await this.metadata(record);
      this.requireUnchangedMetadata(record, metadata);
      for (const entry of record.assets) {
        await assertLocalStagingSource(entry.source_path, { asset: entry.upload.asset,
          length_bytes: entry.upload.length_bytes, sha256: entry.upload.sha256 });
      }
      const { base_metadata_sha256: _, ...target } = record.target;
      const request = parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", ...target,
        service_id: this.config.service_id, request_id: crypto.randomUUID(), action: "publish",
        worker_version_id: service.worker_version_id, service_config_sha256: service.service_config_sha256,
        admission_window_id: service.admission_window_id, payloads: record.assets.map((entry) => entry.upload) });
      const frozen = { ...record, publication: { request, request_sha256: await sqlitePublicationRequestHash(request) } };
      if (!metadata.equals(await this.metadata(record))) throw new Error("Local metadata changed before publication was frozen");
      await checkPreview();
      this.journal.replace(frozen);
      return this.retainStatus(frozen, await this.client.submit(request, sqliteClientIdentity(this.root, this.config, true)!));
    });
  }

  async wait(options: { now?: () => number; delay?: (milliseconds: number) => Promise<void> } = {}): Promise<SqlitePublicationStatus> {
    const now = options.now ?? (() => performance.now()), deadline = now() + 300000;
    let requests = 0;
    const budget = { beforeAttempt: () => {
      if (requests >= 300 || now() >= deadline) return false;
      requests++; return true;
    } };
    while (requests < 300 && now() < deadline) {
      const status = await this.observe(budget);
      if (status?.state === "succeeded") return status;
      if (status?.state === "failed" || status?.state === "blocked") throw new Error(`SQLite publication ${status.state}: ${status.reason_code}`);
      if (requests < 300 && now() < deadline) await (options.delay ?? Bun.sleep)(Math.min(1000, deadline - now()));
    }
    throw new Error("SQLite publication waiting stopped; keep the frozen request and inspect status without resubmitting");
  }
}
