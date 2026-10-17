import { managementIntentHash, managementRequestPrefix, managementSubmissionSchema, m6ServiceConfigHash, serviceConfigSchema,
  signManagementIntent, verifyManagementIntent, verifyManagementResult } from "@castloop/shared";
import type { ManagementCommand, ManagementResult, ManagementSubmission, ServiceConfig } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { ManagementR2Reader, readManagementRuntime } from "./management-r2";
import type { ManagementReader } from "./management-r2";

export type ManagementQueueTransport = {
  prepare: (command: ManagementCommand, grant?: ManagementSubmission) => Promise<ManagementSubmission>;
  send: (submission: ManagementSubmission) => Promise<void>;
  result: (submission: ManagementSubmission) => Promise<ManagementResult | null>;
  wait: (submission: ManagementSubmission) => Promise<ManagementResult>;
};

export class ManagementQueueClient implements ManagementQueueTransport {
  private readonly config: ServiceConfig;
  private readonly sent = new Set<string>();
  constructor(config: ServiceConfig, private readonly adminKey: string, private readonly options: {
    reader?: ManagementReader; api?: Pick<CloudflareApi, "resolvePublicationQueue" | "publishManagementIntent">;
    maximumReads?: number; waitMs?: number; now?: () => number; delay?: (milliseconds: number) => Promise<void>;
  } = {}) { this.config = serviceConfigSchema.parse(config); }
  private reader(): ManagementReader { return this.options.reader ?? new ManagementR2Reader(this.config); }
  private api(): Pick<CloudflareApi, "resolvePublicationQueue" | "publishManagementIntent"> { return this.options.api ?? new CloudflareApi(this.config); }
  async prepare(command: ManagementCommand, grant?: ManagementSubmission): Promise<ManagementSubmission> {
    const runtime = await readManagementRuntime(this.reader(), this.config);
    if (command.action !== "upload-complete" && runtime.admission.state !== "open") throw new Error("New management commands require open admission");
    if (command.action === "upload-complete" && (!grant || grant.intent.request_id !== command.grant_request_id ||
      grant.intent.command.action !== "stage-start" || JSON.stringify(grant.intent.command.upload) !== JSON.stringify(command.upload) ||
      grant.intent.service_id !== this.config.service_id || grant.intent.service_config_sha256 !== await m6ServiceConfigHash(this.config) ||
      grant.intent_sha256 !== await managementIntentHash(grant.intent) ||
      grant.intent.worker_version_id !== runtime.workerVersionId || grant.intent.admission_window_id !== runtime.admissionWindowId ||
      !await verifyManagementIntent(grant.intent, this.adminKey))) throw new Error("Upload completion must retain its exact grant and admission window");
    const queueId = await this.api().resolvePublicationQueue(this.config);
    const intent = await signManagementIntent({ schema_version: 1, family: "management", protocol: "queue-management-v1",
      service_id: this.config.service_id, request_id: crypto.randomUUID(), worker_version_id: runtime.workerVersionId,
      service_config_sha256: await m6ServiceConfigHash(this.config), admission_window_id: runtime.admissionWindowId, command }, this.adminKey);
    return managementSubmissionSchema.parse({ queue_id: queueId, intent, intent_sha256: await managementIntentHash(intent) });
  }
  async send(input: ManagementSubmission): Promise<void> {
    const submission = managementSubmissionSchema.parse(input);
    if (submission.intent.service_id !== this.config.service_id || submission.intent.service_config_sha256 !== await m6ServiceConfigHash(this.config) ||
      submission.intent_sha256 !== await managementIntentHash(submission.intent) || !await verifyManagementIntent(submission.intent, this.adminKey) ||
      this.sent.has(submission.intent.request_id)) throw new Error("Management submission differs from its frozen identity or was already attempted");
    this.sent.add(submission.intent.request_id);
    await this.api().publishManagementIntent(submission.queue_id, submission.intent);
  }
  async result(input: ManagementSubmission): Promise<ManagementResult | null> {
    const submission = managementSubmissionSchema.parse(input);
    if (submission.intent.service_id !== this.config.service_id || submission.intent_sha256 !== await managementIntentHash(submission.intent) ||
      submission.intent.service_config_sha256 !== await m6ServiceConfigHash(this.config) || !await verifyManagementIntent(submission.intent, this.adminKey)) {
      throw new Error("Management status requires its exact authenticated local submission");
    }
    const object = await this.reader().read(`${managementRequestPrefix(submission.intent.request_id)}/result.json`);
    return object ? verifyManagementResult(JSON.parse(object.source), submission.intent, this.adminKey) : null;
  }
  async wait(submission: ManagementSubmission): Promise<ManagementResult> {
    const reads = this.options.maximumReads ?? 300;
    const waitMs = this.options.waitMs ?? 300000;
    if (!Number.isSafeInteger(reads) || reads < 1 || reads > 300 || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 300000) {
      throw new Error("Invalid bounded management waiting policy");
    }
    const now = this.options.now ?? (() => performance.now());
    const deadline = now() + waitMs;
    for (let index = 0; index < reads && now() < deadline; index++) {
      const result = await this.result(submission);
      if (result && result.state !== "pending") return result;
      if (index + 1 < reads && now() < deadline) {
        await (this.options.delay ?? ((milliseconds) => Bun.sleep(milliseconds)))(Math.min(5000, 1000 + index * 100));
      }
    }
    throw new Error("Management job is still unconfirmed; preserve journals and owners without resending or reopening PUT permission");
  }
}
