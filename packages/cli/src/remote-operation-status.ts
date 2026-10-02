import type { ServiceConfig } from "@castloop/shared";
import { LifecycleAdminClient } from "./lifecycle-client";
import { validateLifecycleClientState } from "./lifecycle-journal";
import { readLocalOperationStatus } from "./local-operation-status";
import type { LocalOperationStatus } from "./local-operation-status";
import type { M6AdminTransport } from "./m6-admin-json";
import { PublicationAdminClient } from "./publication-client";
import { validatePublicationClientState } from "./publication-journal";
import { ShowRegistrationClient } from "./show-registration-client";
import { validateShowRegistrationState } from "./show-registration-journal";
import { StagingAdminClient } from "./staging-client";
import { validateStagingClientState } from "./staging-journal";

export type RemoteOperationStatus = Omit<LocalOperationStatus, "remote_state_checked"> & {
  remote_state_checked: true;
  server_status: Awaited<ReturnType<StagingAdminClient["status"]>> | Awaited<ReturnType<PublicationAdminClient["status"]>> |
    Awaited<ReturnType<LifecycleAdminClient["status"]>> | Awaited<ReturnType<ShowRegistrationClient["status"]>>;
};

export async function readRemoteOperationStatus(root: string, config: ServiceConfig, family: string, operationId: string,
  readAdminKey: () => string, transport: M6AdminTransport = fetch): Promise<RemoteOperationStatus> {
  try {
    const local = readLocalOperationStatus(root, config, family, operationId);
    if (!local.client_state) throw new Error("A frozen local operation record is required for remote inspection");
    const before = JSON.stringify(local);
    const key = readAdminKey();
    let server: RemoteOperationStatus["server_status"];
    if (local.family === "staging") {
      const state = validateStagingClientState(local.client_state);
      server = await new StagingAdminClient(config, key, transport).status(state.upload);
    } else if (local.family === "publication") {
      const state = validatePublicationClientState(local.client_state);
      server = await new PublicationAdminClient(config, key, transport).status(state.publication);
    } else if (local.family === "lifecycle") {
      const state = validateLifecycleClientState(local.client_state);
      server = await new LifecycleAdminClient(config, key, transport).status({ schema_version: 1,
        service_id: state.claim.service_id, action: "status", request: state.claim.request });
    } else {
      const state = validateShowRegistrationState(local.client_state);
      server = await new ShowRegistrationClient(config, key, transport).status({ ...state.reserve, action: "status" });
    }
    if (JSON.stringify(readLocalOperationStatus(root, config, family, operationId)) !== before) {
      throw new Error("Local operation record or lock changed during remote inspection");
    }
    return { ...local, remote_state_checked: true, server_status: server };
  } catch {
    throw new Error("Operation status could not be verified; preserve records, locks and ownership without automatic retry or recovery");
  }
}
