import { z } from "zod";
import { publicationCommitKey, publicationOperationSchema, publicationRequestSchema, serviceConfigSchema, serviceIdentitySchema as identitySchema, serviceOperationIdentity as identityFromConfig } from "@castloop/shared";
import type { PublicationRequest, ServiceConfig } from "@castloop/shared";
import { publicationClientOperation } from "./publication-client";
import { readBoundedLocalJournal } from "./local-journal-read";
import { ensureLocalJournalParents, localJournalEntryExists as existsSync } from "./local-journal-path";
import { createLocalJournalStorage } from "./local-journal-storage";
import { createHash } from "node:crypto";
import { join } from "node:path";

const stateSchema = z.object({ schema_version: z.literal(1), identity: identitySchema, publication: publicationRequestSchema,
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["prepared", "claim_requested", "claimed", "commit_requested", "committed"]),
  claim_receipt: publicationOperationSchema.optional(),
  commit_receipt: z.object({ key: z.string().min(1).max(256), created: z.boolean() }).strict().optional(),
  retry: z.object({ attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), state: z.enum(["requested", "requeued"]),
    key: z.string().min(1).max(256).optional() }).strict().optional(),
}).strict();

export type PublicationClientState = z.infer<typeof stateSchema>;
export type PublicationJournal = { load: () => PublicationClientState; save: (state: PublicationClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };

export function validatePublicationClientState(input: unknown): PublicationClientState {
  const state = stateSchema.parse(input);
  const phase = stateSchema.shape.phase.options.indexOf(state.phase);
  const origin = new URL(state.identity.public_base_url);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    state.manifest_sha256 !== createHash("sha256").update(JSON.stringify(state.publication)).digest("hex") ||
    (phase >= 2) !== (state.claim_receipt !== undefined) || (phase === 4) !== (state.commit_receipt !== undefined) ||
    state.claim_receipt && JSON.stringify(state.claim_receipt) !== JSON.stringify(publicationClientOperation(state.publication)) ||
    state.commit_receipt && state.commit_receipt.key !== publicationCommitKey(state.publication.commit) || state.retry && (phase !== 4 ||
      state.retry.state === "requested" && state.retry.key !== undefined ||
      state.retry.state === "requeued" && state.retry.key !== publicationCommitKey(state.publication.commit))) {
    throw new Error("Publication journal has inconsistent frozen identity, phase or receipts");
  }
  publicationClientOperation(state.publication);
  return state;
}

function readRecord(file: string): PublicationClientState {
  return validatePublicationClientState(readBoundedLocalJournal(file));
}

export function readLocalPublicationJob(root: string, input: ServiceConfig, jobId: string):
  { client_state: PublicationClientState | null; lock_present: boolean; remote_state_checked: false } {
  const config = serviceConfigSchema.parse(input);
  const id = publicationOperationSchema.shape.job_id.parse(jobId);
  ensureLocalJournalParents(root, "publication-jobs", config.service_id);
  const file = join(root, ".castloop", "publication-jobs", config.service_id, `${id}.json`);
  const state = existsSync(file) ? readRecord(file) : null;
  if (state && (JSON.stringify(state.identity) !== JSON.stringify(identityFromConfig(config)) || state.publication.request.job_id !== id)) {
    throw new Error("Local publication journal belongs to another service/account/Worker/origin or job");
  }
  return { client_state: state, lock_present: existsSync(`${file}.lock`), remote_state_checked: false };
}

export function createPublicationJournal(root: string, configInput: ServiceConfig, input: PublicationRequest): PublicationJournal {
  const config = serviceConfigSchema.parse(configInput);
  const publication = publicationRequestSchema.parse(input);
  const prepared = validatePublicationClientState({ schema_version: 1, identity: identityFromConfig(config), publication, phase: "prepared",
    manifest_sha256: createHash("sha256").update(JSON.stringify(publication)).digest("hex") });
  const storage = createLocalJournalStorage(root, "publication-jobs", config.service_id, `${publication.request.job_id}.json`);
  const load = (): PublicationClientState => {
    const state = validatePublicationClientState(storage.read());
    if (JSON.stringify(state.identity) !== JSON.stringify(prepared.identity) || state.manifest_sha256 !== prepared.manifest_sha256) {
      throw new Error("This job already has a different frozen publication manifest");
    }
    return state;
  };
  storage.initialize(prepared);
  load();
  return {
    load,
    save: (input) => {
      storage.requireLock("Publication journal writes require its exclusive client lock");
      const next = validatePublicationClientState(input);
      const previous = load();
      const phases = stateSchema.shape.phase.options;
      const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
      const retryChanged = JSON.stringify(next.retry) !== JSON.stringify(previous.retry);
      const retryStarted = next.phase === "committed" && next.retry?.state === "requested" &&
        (!previous.retry || previous.retry.state === "requeued") && next.retry.attempt === (previous.retry?.attempt ?? 0) + 1;
      const retryAcknowledged = previous.retry?.state === "requested" && next.retry?.state === "requeued" && next.retry.attempt === previous.retry.attempt;
      if (JSON.stringify(next.identity) !== JSON.stringify(previous.identity) || next.manifest_sha256 !== previous.manifest_sha256 ||
        distance < 0 || distance > 1 || distance === 0 && JSON.stringify(next) !== JSON.stringify(previous) &&
          !(previous.phase === "committed" && retryChanged && (retryStarted || retryAcknowledged)) ||
        previous.claim_receipt && JSON.stringify(next.claim_receipt) !== JSON.stringify(previous.claim_receipt) ||
        previous.commit_receipt && JSON.stringify(next.commit_receipt) !== JSON.stringify(previous.commit_receipt) || distance !== 0 && retryChanged) {
        throw new Error("Frozen publication journal cannot change, skip phases or replay an unknown request");
      }
      storage.replace(next);
    },
    exclusively: storage.exclusively,
  };
}
