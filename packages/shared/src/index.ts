import * as TOML from "@iarna/toml";
import { z } from "zod";
import { lifecycleJobStatusSchema } from "./lifecycle-job";
import { lifecycleStateSchema } from "./lifecycle";
import { publishedTimestampSchema as publishedAt } from "./metadata-time";
import { episodeCommitSchema, showCommitSchema } from "./publication-request";
export { episodeCommitSchema, publicationCommitKey, publicationManifestHash, publicationRequestSchema, showCommitSchema } from "./publication-request";
export type { PublicationRequest } from "./publication-request";
export { publicationAdminRequestSchema, publicationAdminResponseSchema, publicationOperationSchema } from "./publication-admin";
export type { PublicationAdminRequest, PublicationAdminResponse, PublicationOperationIdentity } from "./publication-admin";
export { lifecycleFailureForPhase, lifecycleFailureMessages, lifecycleJobStatusSchema, lifecyclePhaseSchema, lifecycleProgressSchema,
  parseLifecycleProgress, stringifyLifecycleProgress } from "./lifecycle-job";
export type { LifecycleFailure, LifecycleJobStatus, LifecycleProgress } from "./lifecycle-job";
export { lifecycleCommitKey, lifecycleCommitSchema, parseLifecycleCommitKey } from "./lifecycle-commit";
export type { LifecycleCommit, LifecycleCommitTarget } from "./lifecycle-commit";
export { lifecycleAdminRequestSchema, lifecycleAdminResponseSchema, lifecycleOperationRequestSchema } from "./lifecycle-admin";
export type { LifecycleAdminRequest, LifecycleAdminResponse, LifecycleOperationRequest } from "./lifecycle-admin";
export { parseStageReadbackReceipts, stageAssetSchema, stageControlRequest, stageDraftPrefix, stagePayloadKey, stagePayloadSchema,
  stageReadbackReceiptSchema, stageSettlementSchema, stageUploadProgressSchema, stageUploadRequestSchema } from "./staging";
export type { StageAsset, StagePayload, StageReadbackReceipt, StageSettlement, StageUploadProgress, StageUploadRequest } from "./staging";
export { stagingAdminRequestSchema, stagingAdminResponseSchema, stagingOperationSchema } from "./staging-admin";
export type { StagingAdminRequest, StagingAdminResponse, StagingOperation } from "./staging-admin";
export { showRegistrationRequestSchema, showRegistrationResponseSchema, showReservationSchema } from "./show-registration";
export type { ShowRegistrationRequest, ShowRegistrationResponse, ShowReservation } from "./show-registration";
export { validateId } from "./ids";
export { normalizeHostname } from "./hostname";
export { domainAdminRequestSchema, domainAdminResponseSchema, domainOperationRequestSchema, domainRuntimeProbeSchema } from "./domain-admin";
export type { DomainAdminRequest, DomainAdminResponse, DomainOperationRequest, DomainConnectionReceipt } from "./domain-admin";
export { parsePublicAssetPath } from "./public-assets";
export type { PublicAsset } from "./public-assets";
export { controlActionSchema, controlRequestSchema, episodeLifecycleSchema, lifecycleStateSchema,
  parseControlRequest, parseEpisodeLifecycle, parseShowControl, permitsControlAction,
  showControlSchema, stringifyLifecycleToml } from "./lifecycle";
export type { ControlAction, ControlRequest, EpisodeLifecycle, LifecycleState, ShowControl } from "./lifecycle";
export { CONTENT_LIST_PAGE_SIZE, contentListRequestSchema, contentListResponseSchema } from "./content-list";
export type { ContentListRequest, ContentListResponse } from "./content-list";
export { m6RuntimeTargetSchema, m6RuntimeReadinessSchema, m6ServiceUpdateRequestSchema, serviceAdmissionSchema, serviceInvocationKindSchema, serviceMigrationRequestSchema,
  serviceUrlChangeProgressSchema, serviceUrlChangeRequestSchema } from "./service-admission";
export type { M6RuntimeTarget, M6RuntimeReadiness, M6ServiceReadiness, M6ServiceUpdateRequest, ServiceAdmission, ServiceInvocationKind, ServiceMigrationRequest,
  ServiceUrlChangeProgress, ServiceUrlChangeRequest } from "./service-admission";
export { frozenMigrationPlanSchema, migrationApplyProgressSchema, migrationRuntimeProofSchema } from "./migration-plan";
export type { FrozenMigrationPlan, MigrationApplyProgress, MigrationRuntimeProof } from "./migration-plan";
export { serviceCapabilitiesSchema } from "./service-capabilities";
export type { ServiceCapabilities } from "./service-capabilities";
export { cachedDeliveryRuntimeSchema } from "./delivery-runtime";
export type { CachedDeliveryRuntime } from "./delivery-runtime";
export { workerSettingsSnapshotSchema, workerDeploymentsSnapshotSchema, workerVersionSnapshotSchema, workerSubdomainSnapshotSchema,
  workerScriptUploadReceiptSchema, workerVersionUploadReceiptSchema, workerVersionsSnapshotSchema, m6WorkerDeploymentEvidenceSchema } from "./worker-deployment";
export type { WorkerSettingsSnapshot, M6WorkerDeploymentEvidence } from "./worker-deployment";
export { buildM6WorkerUploadMetadata, buildMigrationCandidateUpload, inspectM6WorkerDeployment, collectM6DeploymentSnapshot,
  m6DeploymentSnapshotSchema, m6SnapshotReads, M6_WORKER_COMPATIBILITY_DATE, M6_FRESH_WORKER_COMPATIBILITY_DATE,
  requireMigrationBridgeSettings, requireMigrationBridgeVersion } from "./m6-worker-deployment";
export type { M6DeploymentReads, M6DeploymentSnapshot, M6WorkerUploadMetadata } from "./m6-worker-deployment";
export { m6SetupRecordKey, m6SetupRequestSchema, m6SetupRecordSchema, m6SetupQueueProbeSchema, m6SetupProbeSchema, m6SetupStatusSchema,
  m6SetupCompleteSchema, m6SetupCompletedSchema, m6SetupHealthSchema, m6UpdateBeginSchema, m6UpdateAdmittedSchema } from "./m6-setup";
export type { M6SetupRequest, M6SetupRecord, M6SetupProbe } from "./m6-setup";
export type { WorkerVersionUploadReceipt } from "./worker-deployment";
export { m6ServiceAdminRequestSchema, m6ServiceAdminResponseSchema } from "./m6-service-admin";
export type { M6ServiceAdminRequest, M6ServiceAdminResponse } from "./m6-service-admin";
export { migrationCandidateUploadSchema } from "./worker-deployment";
export type { MigrationCandidateUpload } from "./worker-deployment";
export { migrationBridgeUploadSchema, migrationBridgePreparationSchema } from "./worker-deployment";
export type { MigrationBridgeUpload, MigrationBridgePreparation } from "./worker-deployment";
export { legacyWorkerInspectionSchema } from "./worker-deployment";
export type { LegacyWorkerInspection } from "./worker-deployment";
export { migrationBridgeDeploymentRequestSchema, migrationBridgeDeploymentEvidenceSchema, migrationBridgeClientStateSchema } from "./worker-deployment";
export type { MigrationBridgeDeploymentRequest, MigrationBridgeDeploymentEvidence, MigrationBridgeClientState } from "./worker-deployment";
export { migrationServiceIdentitySchema, migrationOperationIdentitySchema, migrationPauseRequestSchema,
  migrationInitializationRequestSchema, migrationInitializationResultSchema, migrationActionResponseSchema } from "./migration-admin";
export type { MigrationInitializationResult } from "./migration-admin";
export { migrationSetupRequestSchema, migrationSetupClientStateSchema } from "./migration-setup";
export type { MigrationSetupRequest, MigrationSetupClientState } from "./migration-setup";
export { migrationQuiescenceSchema, migrationBootstrapRequestSchema, migrationDeploymentSettlementSchema, migrationBootstrapSchema } from "./migration-bootstrap";
export type { MigrationQuiescence, MigrationBootstrapRequest, MigrationBootstrap } from "./migration-bootstrap";
export { migrationAdminStatusSchema, migrationDeploymentClientStateSchema } from "./migration-bootstrap";
export type { MigrationAdminStatus, MigrationDeploymentClientState } from "./migration-bootstrap";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = (max: number) => z.string().max(max).regex(SLUG);
const webUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname &&
    !url.username && !url.password && !url.hash;
}, "Expected an HTTP(S) URL without credentials or fragment");

function workersDevOrigin(value: string, workerName: string): string {
  const url = new URL(value);
  const labels = url.hostname.split(".");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
    labels.length !== 4 || labels[0] !== workerName || labels[2] !== "workers" || labels[3] !== "dev" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[1]!)) {
    throw new Error("Management requires its matching workers.dev HTTPS origin without credentials, path, query or port");
  }
  return url.origin;
}

const serviceConfigBaseSchema = z.object({
  schema_version: z.literal(1),
  service_id: ID(20),
  account_id: z.string().regex(/^[a-f0-9]{32}$/i),
  bucket_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  worker_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  queue_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  dlq_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  public_base_url: webUrl.refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.search && url.pathname === "/";
  }, "The public Worker URL must be an HTTPS origin without path, query or port"),
  workers_dev_base_url: z.url().optional(),
}).strict();
export const serviceIdentitySchema = serviceConfigBaseSchema.pick({ service_id: true, account_id: true, worker_name: true, public_base_url: true });
export const serviceConfigSchema = serviceConfigBaseSchema.superRefine((value, context) => {
  if (value.workers_dev_base_url !== undefined) {
    try { workersDevOrigin(value.workers_dev_base_url, value.worker_name); }
    catch { context.addIssue({ code: "custom", path: ["workers_dev_base_url"], message: "Expected this Worker's workers.dev HTTPS origin" }); }
  }
});

export const showMetadataSchema = z.object({
  schema_version: z.literal(1),
  show_id: ID(32),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  author: z.string().trim().min(1),
  owner_name: z.string().trim().min(1),
  owner_email: z.email(),
  categories: z.array(z.string().trim().min(1)).min(1),
  explicit: z.boolean(),
  site_url: webUrl,
  image_path: z.string().regex(/^[^/\\.][^/\\]*\.(?:jpg|jpeg|png)$/i),
  copyright: z.string().min(1).optional(),
  show_type: z.enum(["episodic", "serial"]).optional(),
}).strict();

export const episodeDraftSchema = z.object({
  schema_version: z.literal(1),
  episode_id: ID(80),
  guid: z.uuid(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  published_at: publishedAt,
  explicit: z.boolean().optional(),
  episode_type: z.enum(["full", "trailer", "bonus"]).optional(),
  season_number: z.number().int().positive().optional(),
  episode_number: z.number().int().positive().optional(),
}).strict();

export const episodeRevisionSchema = episodeDraftSchema.extend({
  revision_id: z.uuid(),
  enclosure_url: webUrl,
  content_type: z.literal("audio/mpeg"),
  length_bytes: z.number().int().positive().max(300_000_000),
  duration_seconds: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updated_at: publishedAt,
}).strict();

export const targetInspectionRequestSchema = z.object({ schema_version: z.literal(1), service_id: ID(20),
  kind: z.enum(["show", "episode"]), show_id: ID(32), episode_id: ID(80).optional() }).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode inspections require an Episode ID" });
  }
});
const targetStateSchema = z.object({ lifecycle: lifecycleStateSchema, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const targetInspectionResponseSchema = z.object({ schema_version: z.literal(1), result: z.literal("target"),
  request: targetInspectionRequestSchema, snapshot_only: z.literal(true), authorizes_operation: z.literal(false),
  payloads_verified: z.literal(false), admission_state: z.enum(["open", "paused"]),
  show: targetStateSchema.nullable(), episode: targetStateSchema.nullable(), unfinished_show_operation: z.boolean(),
  current_revision: episodeRevisionSchema.nullable() }).strict().superRefine((value, context) => {
  const episode = value.request.kind === "episode";
  const published = value.episode && ["active", "unpublished"].includes(value.episode.lifecycle);
  if (!episode && (value.episode || value.current_revision) || !value.show && (value.episode || value.unfinished_show_operation || value.current_revision) ||
    value.current_revision && (value.current_revision.episode_id !== value.request.episode_id || !published) ||
    episode && published && !value.unfinished_show_operation && !value.current_revision ||
    value.unfinished_show_operation && value.current_revision) {
    context.addIssue({ code: "custom", message: "Target inspection has inconsistent target, lifecycle or revision evidence" });
  }
});
export type TargetInspectionRequest = z.infer<typeof targetInspectionRequestSchema>;
export type TargetInspectionResponse = z.infer<typeof targetInspectionResponseSchema>;

export const publicationJobStatusSchema = z.object({
  schema_version: z.literal(1),
  job_id: z.uuid(),
  show_id: ID(32),
  kind: z.enum(["show", "episode"]),
  episode_id: ID(80).optional(),
  state: z.enum(["processing", "retrying", "failed", "published"]),
  reason: z.string().optional(),
}).strict();

export const jobStatusSchema = z.discriminatedUnion("schema_version", [publicationJobStatusSchema, lifecycleJobStatusSchema]);

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>;
export type ShowMetadata = z.infer<typeof showMetadataSchema>;
export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;
export type ShowCommit = z.infer<typeof showCommitSchema>;
export type EpisodeCommit = z.infer<typeof episodeCommitSchema>;
export type EpisodeRevision = z.infer<typeof episodeRevisionSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type PublicationJobStatus = z.infer<typeof publicationJobStatusSchema>;

export function serviceManagementBaseUrl(config: ServiceConfig): string {
  return workersDevOrigin(config.workers_dev_base_url ?? config.public_base_url, config.worker_name);
}

export function serviceOperationIdentity(config: ServiceConfig): ServiceIdentity {
  return serviceIdentitySchema.parse({ service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, public_base_url: serviceManagementBaseUrl(config) });
}

export function episodeDraftFromRevision(revision: EpisodeRevision): EpisodeDraft {
  return episodeDraftSchema.parse(Object.fromEntries(
    Object.keys(episodeDraftSchema.shape).filter((key) => key in revision)
      .map((key) => [key, revision[key as keyof EpisodeDraft]]),
  ));
}

function parseToml(source: string): unknown {
  return TOML.parse(source);
}

export function parseServiceConfig(source: string): ServiceConfig {
  return serviceConfigSchema.parse(parseToml(source));
}

export async function m6ServiceConfigHash(config: ServiceConfig): Promise<string> {
  const source = JSON.stringify(serviceConfigSchema.parse(config));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseShowMetadata(source: string): ShowMetadata {
  return showMetadataSchema.parse(parseToml(source));
}

export function parseEpisodeDraft(source: string): EpisodeDraft {
  return episodeDraftSchema.parse(parseToml(source));
}

export function parseJobStatus(source: string): JobStatus {
  return jobStatusSchema.parse(parseToml(source));
}

export function parseEpisodeRevision(source: string): EpisodeRevision {
  return episodeRevisionSchema.parse(parseToml(source));
}

export function stringifyToml(value: ServiceConfig | ShowMetadata | EpisodeDraft | EpisodeRevision | JobStatus): string {
  return TOML.stringify(value as TOML.JsonMap);
}
