import type { ServiceConfig } from "@castloop/shared";
import { readLocalLifecycleJob } from "./lifecycle-journal";
import { readLocalPublicationJob } from "./publication-journal";
import { readLocalStagingOperation } from "./staging-journal";
import { readLocalShowRegistration } from "./show-registration-journal";

export type LocalOperationStatus = {
  family: "staging" | "publication" | "lifecycle" | "show-registration";
  operation_id: string;
  client_state: ReturnType<typeof readLocalStagingOperation>["client_state"] |
    ReturnType<typeof readLocalPublicationJob>["client_state"] | ReturnType<typeof readLocalLifecycleJob>["client_state"] |
    ReturnType<typeof readLocalShowRegistration>["client_state"];
  lock_present: boolean;
  remote_state_checked: false;
  authorizes_mutation: false;
  authorizes_recovery: false;
};

export function readLocalOperationStatus(root: string, config: ServiceConfig, family: string, operationId: string): LocalOperationStatus {
  if (family !== "staging" && family !== "publication" && family !== "lifecycle" && family !== "show-registration") {
    throw new Error("Local operation family must be staging, publication, lifecycle or show-registration");
  }
  try {
    const result = family === "staging" ? readLocalStagingOperation(root, config, operationId) : family === "publication" ?
      readLocalPublicationJob(root, config, operationId) : family === "lifecycle" ? readLocalLifecycleJob(root, config, operationId) :
      readLocalShowRegistration(root, config, operationId);
    return { family, operation_id: operationId, ...result, authorizes_mutation: false, authorizes_recovery: false };
  } catch {
    throw new Error("Local operation journal could not be verified; preserve its record and lock for explicit investigation");
  }
}
