import { z } from "zod";
import { lifecycleAdminRequestSchema, lifecycleCommitSchema, serviceConfigSchema } from "@castloop/shared";
import type { LifecycleAdminRequest, ServiceConfig } from "@castloop/shared";
import { readBoundedLocalJournal } from "./local-journal-read";
import { ensureLocalJournalParents, localJournalEntryExists as existsSync, releaseLocalJournalLock, syncLocalJournalDirectory } from "./local-journal-path";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const claimSchema = lifecycleAdminRequestSchema.transform((value, context) => {
  if (value.action !== "claim") {
    context.addIssue({ code: "custom", message: "Lifecycle journal requires a frozen claim request" });
    return z.NEVER;
  }
  return value;
});
const identitySchema = serviceConfigSchema.pick({ service_id: true, account_id: true, worker_name: true, public_base_url: true });
const stateSchema = z.object({ schema_version: z.literal(1), identity: identitySchema, claim: claimSchema,
  phase: z.enum(["prepared", "claim_requested", "claimed", "commit_requested", "committed"]),
  claim_receipt: lifecycleCommitSchema.optional(),
  commit_receipt: z.object({ key: z.string().min(1).max(256), created: z.boolean() }).strict().optional(),
  retry: z.object({ attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), state: z.enum(["requested", "requeued"]),
    key: z.string().min(1).max(256).optional() }).strict().optional(),
}).strict();

export type LifecycleClientState = z.infer<typeof stateSchema>;
export type LifecycleJournal = { load: () => LifecycleClientState; save: (state: LifecycleClientState) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T> };

export function expectedLifecycleOperation(claim: LifecycleClientState["claim"]): z.infer<typeof lifecycleCommitSchema> {
  const request = claimSchema.parse(claim).request;
  return lifecycleCommitSchema.parse({ schema_version: 1, kind: request.kind, job_id: request.job_id, show_id: request.show_id,
    ...(request.episode_id ? { episode_id: request.episode_id } : {}), action: request.action,
    show_generation: request.expected_show_generation + 1, request_sha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") });
}

export function validateLifecycleClientState(input: unknown): LifecycleClientState {
  const state = stateSchema.parse(input);
  const operation = expectedLifecycleOperation(state.claim);
  const origin = new URL(state.identity.public_base_url);
  const phase = stateSchema.shape.phase.options.indexOf(state.phase);
  const key = operation.kind === "show" ? `staging/lifecycle/shows/${operation.show_id}/${operation.job_id}/commit.json` :
    `staging/lifecycle/episodes/${operation.show_id}/${operation.episode_id}/${operation.job_id}/commit.json`;
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    state.claim.service_id !== state.identity.service_id || state.claim.confirmation.request_sha256 !== operation.request_sha256 ||
    (phase >= 2) !== (state.claim_receipt !== undefined) || (phase === 4) !== (state.commit_receipt !== undefined) ||
    state.claim_receipt && JSON.stringify(state.claim_receipt) !== JSON.stringify(operation) ||
    state.commit_receipt && state.commit_receipt.key !== key || state.retry && (phase !== 4 ||
      state.retry.state === "requested" && state.retry.key !== undefined || state.retry.state === "requeued" && state.retry.key !== key)) {
    throw new Error("Lifecycle journal has inconsistent frozen identity, phase or receipts");
  }
  return state;
}

function readRecord(file: string): LifecycleClientState {
  return validateLifecycleClientState(readBoundedLocalJournal(file));
}

function matchesConfig(state: LifecycleClientState, config: ServiceConfig): boolean {
  return JSON.stringify(state.identity) === JSON.stringify(identityFromConfig(config));
}

function identityFromConfig(config: ServiceConfig): z.infer<typeof identitySchema> {
  return identitySchema.parse({ service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, public_base_url: config.public_base_url });
}

export function readLocalLifecycleJob(root: string, input: ServiceConfig, jobId: string):
  { client_state: LifecycleClientState | null; lock_present: boolean; remote_state_checked: false } {
  const config = serviceConfigSchema.parse(input);
  const id = lifecycleCommitSchema.shape.job_id.parse(jobId);
  ensureLocalJournalParents(root, "lifecycle-jobs", config.service_id);
  const file = join(root, ".castloop", "lifecycle-jobs", config.service_id, `${id}.json`);
  const state = existsSync(file) ? readRecord(file) : null;
  if (state && (!matchesConfig(state, config) || state.claim.request.job_id !== id)) throw new Error("Local lifecycle journal belongs to another service or job");
  return { client_state: state, lock_present: existsSync(`${file}.lock`), remote_state_checked: false };
}

export function createLifecycleJournal(root: string, configInput: ServiceConfig, input: Extract<LifecycleAdminRequest, { action: "claim" }>): LifecycleJournal {
  const config = serviceConfigSchema.parse(configInput);
  const prepared = validateLifecycleClientState({ schema_version: 1, identity: identityFromConfig(config), claim: input, phase: "prepared" });
  const file = join(root, ".castloop", "lifecycle-jobs", config.service_id, `${prepared.claim.request.job_id}.json`);
  ensureLocalJournalParents(root, "lifecycle-jobs", config.service_id, true);
  const syncDirectory = () => syncLocalJournalDirectory(dirname(file));
  const load = (): LifecycleClientState => {
    ensureLocalJournalParents(root, "lifecycle-jobs", config.service_id);
    const state = readRecord(file);
    if (!matchesConfig(state, config) || JSON.stringify(state.claim) !== JSON.stringify(prepared.claim)) {
      throw new Error("This job already has a different frozen lifecycle request");
    }
    return state;
  };
  if (!existsSync(file)) {
    if (existsSync(`${file}.lock`)) throw new Error("Preserve the retained lifecycle lock without recreating its missing journal");
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(prepared)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory();
  }
  load();
  let locked = false;
  return {
    load,
    save: (input) => {
      if (!locked) throw new Error("Lifecycle journal writes require its exclusive client lock");
      const next = validateLifecycleClientState(input);
      const previous = load();
      const phases = stateSchema.shape.phase.options;
      const distance = phases.indexOf(next.phase) - phases.indexOf(previous.phase);
      const retryChanged = JSON.stringify(next.retry) !== JSON.stringify(previous.retry);
      const retryStarted = next.phase === "committed" && next.retry?.state === "requested" &&
        (!previous.retry || previous.retry.state === "requeued") && next.retry.attempt === (previous.retry?.attempt ?? 0) + 1;
      const retryAcknowledged = previous.retry?.state === "requested" && next.retry?.state === "requeued" &&
        next.retry.attempt === previous.retry.attempt;
      if (JSON.stringify(next.identity) !== JSON.stringify(previous.identity) || JSON.stringify(next.claim) !== JSON.stringify(previous.claim) ||
        distance < 0 || distance > 1 || distance === 0 && JSON.stringify(next) !== JSON.stringify(previous) &&
          !(previous.phase === "committed" && retryChanged && (retryStarted || retryAcknowledged)) ||
        previous.claim_receipt && JSON.stringify(next.claim_receipt) !== JSON.stringify(previous.claim_receipt) ||
        previous.commit_receipt && JSON.stringify(next.commit_receipt) !== JSON.stringify(previous.commit_receipt) ||
        distance !== 0 && retryChanged) {
        throw new Error("Frozen lifecycle journal cannot change, skip phases or replay an unknown request");
      }
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      syncDirectory();
    },
    exclusively: async (callback) => {
      ensureLocalJournalParents(root, "lifecycle-jobs", config.service_id);
      const lock = `${file}.lock`;
      const fd = openSync(lock, "wx", 0o600);
      locked = true;
      try { fsyncSync(fd); syncDirectory(); return await callback(); }
      finally { locked = false; releaseLocalJournalLock(root, "lifecycle-jobs", config.service_id, lock, fd); }
    },
  };
}
