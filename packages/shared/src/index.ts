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
export { stageAssetSchema, stageControlRequest, stageDraftPrefix, stagePayloadKey, stagePayloadSchema,
  stageUploadProgressSchema, stageUploadRequestSchema } from "./staging";
export type { StageAsset, StagePayload, StageUploadProgress, StageUploadRequest } from "./staging";
export { stagingAdminRequestSchema, stagingAdminResponseSchema, stagingOperationSchema } from "./staging-admin";
export type { StagingAdminRequest, StagingAdminResponse, StagingOperation } from "./staging-admin";
export { showRegistrationRequestSchema, showRegistrationResponseSchema, showReservationSchema } from "./show-registration";
export type { ShowRegistrationRequest, ShowRegistrationResponse, ShowReservation } from "./show-registration";
export { validateId } from "./ids";
export { parsePublicAssetPath } from "./public-assets";
export type { PublicAsset } from "./public-assets";
export { controlActionSchema, controlRequestSchema, episodeLifecycleSchema, lifecycleStateSchema,
  parseControlRequest, parseEpisodeLifecycle, parseShowControl, permitsControlAction,
  showControlSchema, stringifyLifecycleToml } from "./lifecycle";
export type { ControlAction, ControlRequest, EpisodeLifecycle, LifecycleState, ShowControl } from "./lifecycle";
export { serviceAdmissionSchema, serviceInvocationKindSchema, serviceMigrationRequestSchema } from "./service-admission";
export type { ServiceAdmission, ServiceInvocationKind, ServiceMigrationRequest } from "./service-admission";
export { frozenMigrationPlanSchema, migrationApplyProgressSchema, migrationRuntimeProofSchema } from "./migration-plan";
export type { FrozenMigrationPlan, MigrationApplyProgress, MigrationRuntimeProof } from "./migration-plan";
export { serviceCapabilitiesSchema } from "./service-capabilities";
export type { ServiceCapabilities } from "./service-capabilities";
export { cachedDeliveryRuntimeSchema } from "./delivery-runtime";
export type { CachedDeliveryRuntime } from "./delivery-runtime";
export { workerSettingsSnapshotSchema, workerDeploymentsSnapshotSchema, workerVersionSnapshotSchema, workerSubdomainSnapshotSchema,
  m6WorkerDeploymentEvidenceSchema } from "./worker-deployment";
export type { WorkerSettingsSnapshot, M6WorkerDeploymentEvidence } from "./worker-deployment";
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

export const serviceConfigSchema = z.object({
  schema_version: z.literal(1),
  service_id: ID(20),
  account_id: z.string().regex(/^[a-f0-9]{32}$/i),
  bucket_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  worker_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  queue_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  dlq_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  public_base_url: webUrl.refine((value) => value.startsWith("https://"),
    "The public Worker URL must use HTTPS"),
}).strict();

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
export type ShowMetadata = z.infer<typeof showMetadataSchema>;
export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;
export type ShowCommit = z.infer<typeof showCommitSchema>;
export type EpisodeCommit = z.infer<typeof episodeCommitSchema>;
export type EpisodeRevision = z.infer<typeof episodeRevisionSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type PublicationJobStatus = z.infer<typeof publicationJobStatusSchema>;

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
