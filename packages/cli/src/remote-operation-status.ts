import { managementStatusSchema } from "@castloop/shared";
import type { ManagementStatus, ServiceConfig } from "@castloop/shared";
import { LifecycleAdminClient } from "./lifecycle-client";
import { validateLifecycleClientState } from "./lifecycle-journal";
import { readLocalOperationStatus } from "./local-operation-status";
import type { LocalOperationStatus } from "./local-operation-status";
import type { M6AdminTransport } from "./m6-admin-json";
import { M6AdminVerificationError } from "./m6-admin-json";
import { PublicationAdminClient } from "./publication-client";
import { validatePublicationClientState } from "./publication-journal";
import { ShowRegistrationClient } from "./show-registration-client";
import { validateShowRegistrationState } from "./show-registration-journal";
import { StagingAdminClient } from "./staging-client";
import { validateStagingClientState } from "./staging-journal";
import { ManagementQueueClient } from "./management-queue-client";
import { ManagementR2Reader } from "./management-r2";

export type RemoteOperationStatus = Omit<LocalOperationStatus, "remote_state_checked"> & {
  remote_state_checked: true;
  server_status: Awaited<ReturnType<StagingAdminClient["status"]>> | Awaited<ReturnType<PublicationAdminClient["status"]>> |
    Awaited<ReturnType<LifecycleAdminClient["status"]>> | Awaited<ReturnType<ShowRegistrationClient["status"]>> | ManagementStatus;
};

export class RemoteOperationStatusError extends Error {
  constructor(readonly reasonCode: M6AdminVerificationError["reasonCode"] | "local_record_invalid" | "administrator_key_invalid" |
    "server_status_unverified" | "local_record_changed") {
    super(`Operation status could not be verified; preserve records, locks and ownership without automatic retry or recovery [reason_code=${reasonCode}]`);
  }
}

export async function readRemoteOperationStatus(root: string, config: ServiceConfig, family: string, operationId: string,
  readAdminKey: () => string, transport: M6AdminTransport = fetch): Promise<RemoteOperationStatus> {
  let reason: ConstructorParameters<typeof RemoteOperationStatusError>[0] = "local_record_invalid";
  let before: string | undefined;
  try {
    const local = readLocalOperationStatus(root, config, family, operationId);
    if (!local.client_state) throw new Error("A frozen local operation record is required for remote inspection");
    before = JSON.stringify(local);
    reason = "administrator_key_invalid";
    const key = readAdminKey();
    reason = "server_status_unverified";
    let server: RemoteOperationStatus["server_status"];
    if (local.family === "staging") {
      const state = validateStagingClientState(local.client_state);
      const submission = state.async_complete ?? state.async_start;
      server = submission ? managementStatusSchema.parse({ result: "management-status", protocol: "queue-management-v1",
        request_id: submission.intent.request_id, snapshot_only: true, authorizes_recovery: false,
        response: await new ManagementQueueClient(config, key, { reader: new ManagementR2Reader(config, {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
          transport: (input, init) => transport(new URL(String(input)), init ?? {}),
        }) }).result(submission) }) : await new StagingAdminClient(config, key, transport).status(state.upload);
    } else if (local.family === "publication") {
      const state = validatePublicationClientState(local.client_state);
      const submission = state.async_submission;
      server = submission ? managementStatusSchema.parse({ result: "management-status", protocol: "queue-management-v1",
        request_id: submission.intent.request_id, snapshot_only: true, authorizes_recovery: false,
        response: await new ManagementQueueClient(config, key, { reader: new ManagementR2Reader(config, {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
          transport: (input, init) => transport(new URL(String(input)), init ?? {}),
        }) }).result(submission) }) : await new PublicationAdminClient(config, key, transport).status(state.publication);
    } else if (local.family === "lifecycle") {
      const state = validateLifecycleClientState(local.client_state);
      server = await new LifecycleAdminClient(config, key, transport).status({ schema_version: 1,
        service_id: state.claim.service_id, action: "status", request: state.claim.request });
    } else {
      const state = validateShowRegistrationState(local.client_state);
      server = await new ShowRegistrationClient(config, key, transport).status({ ...state.reserve, action: "status" });
    }
    reason = "local_record_changed";
    if (JSON.stringify(readLocalOperationStatus(root, config, family, operationId)) !== before) {
      throw new Error("Local operation record or lock changed during remote inspection");
    }
    return { ...local, remote_state_checked: true, server_status: server };
  } catch (error) {
    if (error instanceof M6AdminVerificationError && error.reasonCode === "publication_status_changed") {
      try {
        if (before !== JSON.stringify(readLocalOperationStatus(root, config, family, operationId))) {
          throw new Error("Local operation changed");
        }
      } catch { throw new RemoteOperationStatusError("local_record_changed"); }
    }
    throw new RemoteOperationStatusError(error instanceof M6AdminVerificationError ? error.reasonCode : reason);
  }
}
