import { m6ServiceConfigHash, publicationIntentHash, publicationManifestHash, publicationQueuedReceiptSchema,
  publicationQueueSubmissionSchema, serviceConfigSchema, signPublicationCommitIntent } from "@castloop/shared";
import type { PublicationQueueSubmission, PublicationQueuedReceipt, PublicationRequest, ServiceConfig } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { M6ServiceClient } from "./m6-service-client";
import { publicationClientOperation } from "./publication-client";
import { createHash } from "node:crypto";

export type PublicationQueueTransport = { preflight: () => Promise<void>;
  prepare: (publication: PublicationRequest) => Promise<PublicationQueueSubmission>;
  send: (submission: PublicationQueueSubmission) => Promise<PublicationQueuedReceipt> };

export class PublicationQueueClient implements PublicationQueueTransport {
  private readonly config: ServiceConfig;
  private queueId?: string;
  constructor(config: ServiceConfig, private readonly adminKey: string,
    private readonly dependencies: { api?: Pick<CloudflareApi, "resolvePublicationQueue" | "publishPublicationIntent">;
      service?: Pick<M6ServiceClient, "call"> } = {}) {
    this.config = serviceConfigSchema.parse(config);
  }

  private api(): Pick<CloudflareApi, "resolvePublicationQueue" | "publishPublicationIntent"> {
    return this.dependencies.api ?? new CloudflareApi(this.config);
  }

  private async runtime(requireOpen: boolean): Promise<string> {
    const response = await (this.dependencies.service ?? new M6ServiceClient(this.config, this.adminKey))
      .call({ service_id: this.config.service_id, action: "status" });
    const readiness = response.admission.runtime_readiness ?? response.admission.readiness;
    if (response.publication_commit_protocol !== "queue-commit-v1" || response.publication_acceptance_protocol !== "queue-validation-v1" ||
      !(requireOpen ? response.admission.state === "open" : ["open", "paused"].includes(response.admission.state)) ||
      readiness?.worker_version_id !== response.worker_version_id ||
      response.admission.runtime_readiness && response.admission.runtime_readiness.service_config_sha256 !== await m6ServiceConfigHash(this.config)) {
      throw new Error("Publication requires a ready queue-commit-v1 Worker; update and explicitly resume before a new claim");
    }
    return response.worker_version_id;
  }

  async preflight(): Promise<void> {
    await this.runtime(true);
    this.queueId = await this.api().resolvePublicationQueue(this.config);
  }

  async prepare(publication: PublicationRequest): Promise<PublicationQueueSubmission> {
    const workerVersion = await this.runtime(false);
    const queueId = this.queueId ?? await this.api().resolvePublicationQueue(this.config);
    const intent = await signPublicationCommitIntent({ schema_version: 1, family: "publication_commit", commit_protocol: "queue-commit-v1",
      action: "commit", service_id: this.config.service_id, submission_id: crypto.randomUUID(), operation: publicationClientOperation(publication),
      manifest_sha256: await publicationManifestHash(publication),
      request_sha256: createHash("sha256").update(JSON.stringify(publication.request)).digest("hex"),
      worker_version_id: workerVersion, service_config_sha256: await m6ServiceConfigHash(this.config) }, this.adminKey);
    return publicationQueueSubmissionSchema.parse({ queue_id: queueId, intent, intent_sha256: await publicationIntentHash(intent) });
  }

  async send(input: PublicationQueueSubmission): Promise<PublicationQueuedReceipt> {
    const submission = publicationQueueSubmissionSchema.parse(input);
    if (submission.intent.service_id !== this.config.service_id || submission.intent.service_config_sha256 !== await m6ServiceConfigHash(this.config) ||
      submission.intent_sha256 !== await publicationIntentHash(submission.intent)) throw new Error("Queue submission differs from its frozen service/intent");
    await this.api().publishPublicationIntent(submission.queue_id, submission.intent);
    return publicationQueuedReceiptSchema.parse({ schema_version: 1, result: "queued", commit_protocol: "queue-commit-v1",
      service_id: this.config.service_id, submission_id: submission.intent.submission_id, operation: submission.intent.operation,
      manifest_sha256: submission.intent.manifest_sha256, intent_sha256: submission.intent_sha256, queue_id: submission.queue_id });
  }
}
