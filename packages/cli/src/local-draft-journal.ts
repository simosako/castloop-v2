import { z } from "zod";
import { serviceConfigSchema, stageUploadRequestSchema } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { readBoundedLocalJournal } from "./local-journal-read";
import { readLocalPublicationJob } from "./publication-journal";
import { showRegistrationIdentity, showRegistrationIdentitySchema } from "./show-registration-journal";
import { readLocalStagingOperation } from "./staging-journal";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const targetSchema = z.object({ kind: stageUploadRequestSchema.shape.kind, show_id: stageUploadRequestSchema.shape.show_id,
  episode_id: stageUploadRequestSchema.shape.episode_id }).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.episode_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode drafts require an Episode ID" });
  }
});
const slotSchema = z.enum(["show", "episode_metadata", "audio"]);
const stateSchema = z.object({ schema_version: z.literal(1), identity: showRegistrationIdentitySchema, target: targetSchema,
  draft_job_id: z.uuid(), base_revision_id: z.uuid().optional(), phase: z.enum(["editable", "publication_prepared", "frozen"]),
  uploads: z.array(z.object({ slot: slotSchema, operation_id: z.uuid() }).strict()).max(2),
  publication_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export type LocalDraftTarget = z.infer<typeof targetSchema>;
export type LocalDraftState = z.infer<typeof stateSchema>;
export type LocalDraftEditor = { load: () => LocalDraftState; attachUpload: (operationId: string) => void;
  preparePublication: () => void; acknowledgeCommit: () => void };
export type LocalDraftJournal = { load: () => LocalDraftState;
  exclusively: <T>(callback: (editor: LocalDraftEditor) => Promise<T>) => Promise<T> };

export function validateLocalDraftState(input: unknown): LocalDraftState {
  const state = stateSchema.parse(input);
  const origin = new URL(state.identity.public_base_url);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    state.target.kind === "show" && state.base_revision_id !== undefined ||
    (state.phase !== "editable") !== (state.publication_sha256 !== undefined) ||
    state.phase !== "editable" && state.uploads.length === 0 ||
    new Set(state.uploads.map((upload) => upload.slot)).size !== state.uploads.length ||
    new Set(state.uploads.map((upload) => upload.operation_id)).size !== state.uploads.length ||
    state.uploads.some((upload) => upload.operation_id === state.draft_job_id ||
      (state.target.kind === "show" ? upload.slot !== "show" : upload.slot === "show"))) {
    throw new Error("Local draft has inconsistent identity, target, upload slots or publication phase");
  }
  state.uploads.sort((left, right) => left.slot.localeCompare(right.slot));
  return state;
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function directories(root: string, config: ServiceConfig): string[] {
  return [root, join(root, ".castloop"), join(root, ".castloop", "drafts"), join(root, ".castloop", "drafts", config.service_id)];
}

function checkDirectories(root: string, config: ServiceConfig, create: boolean): void {
  for (const directory of directories(root, config)) {
    if (!present(directory)) {
      if (!create) return;
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(dirname(directory));
    }
    if (!lstatSync(directory).isDirectory()) throw new Error("Local draft parents must be real directories, not symlinks");
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function draftFile(root: string, config: ServiceConfig, target: LocalDraftTarget): string {
  return join(root, ".castloop", "drafts", config.service_id,
    target.kind === "show" ? `show-${target.show_id}.json` : `episode-${target.show_id}--${target.episode_id}.json`);
}

export function readLocalDraft(root: string, configInput: ServiceConfig, targetInput: LocalDraftTarget):
  { client_state: LocalDraftState | null; lock_present: boolean; remote_state_checked: false } {
  const config = serviceConfigSchema.parse(configInput);
  const target = targetSchema.parse(targetInput);
  checkDirectories(root, config, false);
  const file = draftFile(root, config, target);
  const state = present(file) ? validateLocalDraftState(readBoundedLocalJournal(file)) : null;
  if (state && (JSON.stringify(state.identity) !== JSON.stringify(showRegistrationIdentity(config)) ||
    JSON.stringify(state.target) !== JSON.stringify(target))) throw new Error("Local draft belongs to another service or target");
  return { client_state: state, lock_present: present(`${file}.lock`), remote_state_checked: false };
}

export function createLocalDraftJournal(root: string, configInput: ServiceConfig, target: LocalDraftTarget,
  draftJobId: string, baseRevisionId?: string): LocalDraftJournal {
  const config = serviceConfigSchema.parse(configInput);
  const initial = validateLocalDraftState({ schema_version: 1, identity: showRegistrationIdentity(config), target,
    draft_job_id: draftJobId, ...(baseRevisionId !== undefined ? { base_revision_id: baseRevisionId } : {}), phase: "editable", uploads: [] });
  checkDirectories(root, config, true);
  const file = draftFile(root, config, initial.target);
  if (present(`${file}.lock`)) throw new Error("Preserve the retained local draft lock; it cannot be stolen");
  if (!present(file)) {
    const history = join(dirname(file), "history");
    if (present(history) && !lstatSync(history).isDirectory()) throw new Error("Draft history must be a real directory, not a symlink");
    const publication = readLocalPublicationJob(root, config, initial.draft_job_id);
    if (present(join(history, `${initial.draft_job_id}.json`)) || publication.client_state || publication.lock_present) {
      throw new Error("A retained draft or publication identity cannot initialize a missing target head");
    }
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(initial)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dirname(file));
  }
  const load = (): LocalDraftState => {
    const state = readLocalDraft(root, config, initial.target).client_state;
    if (!state || state.draft_job_id !== initial.draft_job_id || state.base_revision_id !== initial.base_revision_id) {
      throw new Error("This target already has a different permanent draft identity or base revision");
    }
    return state;
  };
  load();
  let locked = false;
  const save = (state: LocalDraftState) => {
    if (!locked) throw new Error("Local draft writes require the exclusive target lock");
    load();
    const next = validateLocalDraftState(state);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    syncDirectory(dirname(file));
  };
  const staging = (id: string) => {
    const snapshot = readLocalStagingOperation(root, config, id);
    const upload = snapshot.client_state?.upload;
    if (!upload || snapshot.lock_present || upload.draft_job_id !== initial.draft_job_id || upload.kind !== initial.target.kind ||
      upload.show_id !== initial.target.show_id || upload.episode_id !== initial.target.episode_id) {
      throw new Error("Draft upload requires an exact local target/job journal without a retained upload lock");
    }
    return snapshot.client_state!;
  };
  const publication = (state: LocalDraftState) => {
    const snapshot = readLocalPublicationJob(root, config, state.draft_job_id);
    const job = snapshot.client_state;
    const request = job?.publication.request;
    const commit = job?.publication.commit;
    if (!job || snapshot.lock_present || request?.kind !== state.target.kind || request.show_id !== state.target.show_id ||
      request.episode_id !== state.target.episode_id || (commit?.kind === "episode" ? commit.base_revision_id : undefined) !== state.base_revision_id ||
      JSON.stringify([...job.publication.staged_uploads].sort()) !== JSON.stringify(state.uploads.map((upload) => upload.operation_id).sort()) ||
      state.publication_sha256 && state.publication_sha256 !== job.manifest_sha256) {
      throw new Error("Draft publication requires its exact upload set, target, base and manifest journal without a lock");
    }
    return job;
  };
  const editor: LocalDraftEditor = { load,
    attachUpload: (operationId) => {
      if (!locked) throw new Error("Local draft writes require the exclusive target lock");
      const state = load();
      if (state.phase !== "editable") throw new Error("Publication preparation freezes local draft edits");
      const next = staging(operationId);
      const slot = next.upload.kind === "show" ? "show" : next.upload.payloads[0]!.asset as "episode_metadata" | "audio";
      const previous = state.uploads.find((upload) => upload.slot === slot);
      if (previous?.operation_id === operationId) return;
      if (next.phase !== "prepared") throw new Error("Attach the prepared upload before sending any management request");
      if (previous && staging(previous.operation_id).phase !== "finished") {
        throw new Error("An unresolved upload cannot be replaced, abandoned or inferred complete");
      }
      save({ ...state, uploads: [...state.uploads.filter((upload) => upload.slot !== slot), { slot, operation_id: operationId }] });
    },
    preparePublication: () => {
      if (!locked) throw new Error("Local draft writes require the exclusive target lock");
      const state = load();
      const job = publication(state);
      if (state.phase === "publication_prepared" && job.phase === "prepared") return;
      if (state.phase !== "editable" || job.phase !== "prepared") throw new Error("Freeze the draft before publication claim; never infer an unknown outcome");
      for (const upload of state.uploads) {
        const stage = staging(upload.operation_id);
        if (stage.phase !== "finished" || stage.finish_receipt !== "staged") throw new Error("Publication requires explicit staged receipts");
      }
      save({ ...state, phase: "publication_prepared", publication_sha256: job.manifest_sha256 });
    },
    acknowledgeCommit: () => {
      if (!locked) throw new Error("Local draft writes require the exclusive target lock");
      const state = load();
      const job = publication(state);
      if (job.phase !== "committed" || !state.publication_sha256 || state.phase === "editable") {
        throw new Error("Freeze completion only from an exact acknowledged local commit, never a status observation");
      }
      if (state.phase !== "frozen") save({ ...state, phase: "frozen" });
    } };
  return { load, exclusively: async (callback) => {
    const fd = openSync(`${file}.lock`, "wx", 0o600);
    locked = true;
    try { fsyncSync(fd); syncDirectory(dirname(file)); load(); return await callback(editor); }
    finally { locked = false; closeSync(fd); unlinkSync(`${file}.lock`); syncDirectory(dirname(file)); }
  } };
}

export async function rotateLocalDraft(root: string, configInput: ServiceConfig, targetInput: LocalDraftTarget,
  nextJobId: string, baseRevisionId?: string): Promise<LocalDraftJournal> {
  const config = serviceConfigSchema.parse(configInput);
  const target = targetSchema.parse(targetInput);
  const next = validateLocalDraftState({ schema_version: 1, identity: showRegistrationIdentity(config), target,
    draft_job_id: nextJobId, ...(baseRevisionId !== undefined ? { base_revision_id: baseRevisionId } : {}), phase: "editable", uploads: [] });
  const snapshot = readLocalDraft(root, config, target);
  const previous = snapshot.client_state;
  if (!previous || snapshot.lock_present) throw new Error("Next draft requires its retained predecessor without a client lock");
  if (previous.draft_job_id === nextJobId) return createLocalDraftJournal(root, config, target, nextJobId, baseRevisionId);
  const journal = createLocalDraftJournal(root, config, target, previous.draft_job_id, previous.base_revision_id);
  await journal.exclusively(async (editor) => {
    if (editor.load().phase !== "frozen") throw new Error("Only an acknowledged frozen draft can become a predecessor");
    editor.acknowledgeCommit();
    const frozen = editor.load();
    const archiveDirectory = join(dirname(draftFile(root, config, target)), "history");
    if (!present(archiveDirectory)) { mkdirSync(archiveDirectory, { mode: 0o700 }); syncDirectory(dirname(archiveDirectory)); }
    if (!lstatSync(archiveDirectory).isDirectory()) throw new Error("Draft history must be a real directory, not a symlink");
    const nextPublication = readLocalPublicationJob(root, config, nextJobId);
    if (present(join(archiveDirectory, `${nextJobId}.json`)) || nextPublication.client_state || nextPublication.lock_present) {
      throw new Error("A retained draft or publication identity cannot be reused for new edits");
    }
    const archive = join(archiveDirectory, `${frozen.draft_job_id}.json`);
    if (present(archive)) {
      if (JSON.stringify(validateLocalDraftState(readBoundedLocalJournal(archive))) !== JSON.stringify(frozen)) {
        throw new Error("Preserve the different retained draft history record");
      }
    } else {
      const fd = openSync(archive, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(frozen)); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(archiveDirectory);
    }
    const file = draftFile(root, config, target);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    syncDirectory(dirname(file));
  });
  return createLocalDraftJournal(root, config, target, nextJobId, baseRevisionId);
}
