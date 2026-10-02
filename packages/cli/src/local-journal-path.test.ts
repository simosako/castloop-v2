import { expect, test } from "bun:test";
import { lifecycleAdminRequestSchema, lifecycleOperationRequestSchema, parseServiceConfig, publicationRequestSchema,
  stageUploadRequestSchema } from "@castloop/shared";
import { createLifecycleJournal, readLocalLifecycleJob } from "./lifecycle-journal";
import { createLocalDraftJournal, readLocalDraft } from "./local-draft-journal";
import { ensureLocalJournalParents } from "./local-journal-path";
import { createPublicationJournal, readLocalPublicationJob } from "./publication-journal";
import { createShowRegistrationJournal, readLocalShowRegistration } from "./show-registration-journal";
import { createStagingJournal, readLocalStagingOperation } from "./staging-journal";
import { PUBLICATION_SERVICE_TEXT } from "../../../src/test-support/publication";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const config = parseServiceConfig(PUBLICATION_SERVICE_TEXT);
const digest = "a".repeat(64);
const upload = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
  kind: "show", show_id: "daily", expected_show_generation: 0, created_at: "2026-10-02T12:00:00Z",
  payloads: [{ asset: "show_metadata", length_bytes: 1, sha256: digest }, { asset: "cover_jpg", length_bytes: 1, sha256: digest }] });
const publication = publicationRequestSchema.parse({ schema_version: 1, request: { schema_version: 1, job_id: upload.draft_job_id,
  kind: "show", show_id: "daily", action: "publish", expected_show_generation: 1, created_at: upload.created_at },
  commit: { schema_version: 1, kind: "show", show_id: "daily", job_id: upload.draft_job_id,
    metadata_sha256: digest, cover_sha256: digest, cover_extension: "jpg" }, staged_uploads: [upload.operation_id] });
const request = lifecycleOperationRequestSchema.parse({ schema_version: 1, job_id: crypto.randomUUID(), kind: "show", show_id: "daily",
  action: "unpublish", expected_show_generation: 0, created_at: upload.created_at });
const claim = lifecycleAdminRequestSchema.parse({ schema_version: 1, service_id: config.service_id, action: "claim", request,
  confirmation: { operator_confirmed: true, request_sha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") } });
if (claim.action !== "claim") throw new Error("Invalid fixture claim");
const reserve = { schema_version: 1 as const, service_id: config.service_id, show_id: "daily", reservation_id: crypto.randomUUID(), action: "reserve" as const };
const cases = [
  { family: "staging-uploads", id: upload.operation_id, create: (root: string) => createStagingJournal(root, config, upload),
    read: (root: string) => readLocalStagingOperation(root, config, upload.operation_id) },
  { family: "publication-jobs", id: publication.request.job_id, create: (root: string) => createPublicationJournal(root, config, publication),
    read: (root: string) => readLocalPublicationJob(root, config, publication.request.job_id) },
  { family: "lifecycle-jobs", id: request.job_id, create: (root: string) => createLifecycleJournal(root, config, claim),
    read: (root: string) => readLocalLifecycleJob(root, config, request.job_id) },
  { family: "show-registrations", id: "daily", create: (root: string) => createShowRegistrationJournal(root, config, reserve),
    read: (root: string) => readLocalShowRegistration(root, config, "daily") },
  { family: "drafts", id: "show-daily", create: (root: string) => createLocalDraftJournal(root, config, { kind: "show", show_id: "daily" }, upload.draft_job_id),
    read: (root: string) => readLocalDraft(root, config, { kind: "show", show_id: "daily" }) },
];

for (const family of cases) {
  test(`${family.family} never follows a workspace, state, family or service directory symlink`, () => {
    for (const level of ["root", "state", "family", "service"]) {
      const base = mkdtempSync("/tmp/opencode/castloop-journal-parent-");
      const root = join(base, "workspace");
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "sentinel"), "unchanged");
      try {
        if (level !== "root") mkdirSync(root);
        if (level === "family" || level === "service") mkdirSync(join(root, ".castloop"));
        if (level === "service") mkdirSync(join(root, ".castloop", family.family));
        const target = level === "root" ? root : level === "state" ? join(root, ".castloop") : level === "family" ?
          join(root, ".castloop", family.family) : join(root, ".castloop", family.family, config.service_id);
        symlinkSync(outside, target);
        expect(() => family.read(root)).toThrow("real directories");
        expect(() => family.create(root)).toThrow("real directories");
        expect(readdirSync(outside)).toEqual(["sentinel"]);
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged");
      } finally { rmSync(base, { recursive: true, force: true }); }
    }
  });

  test(`${family.family} retains a dangling lock and cannot recreate a missing journal under it`, () => {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-dangling-lock-");
    try {
      family.create(root);
      const file = join(root, ".castloop", family.family, config.service_id, `${family.id}.json`);
      rmSync(file);
      symlinkSync(join(root, "missing-lock-target"), `${file}.lock`);
      expect(family.read(root).lock_present).toBe(true);
      expect(family.read(root).client_state).toBeNull();
      expect(() => family.create(root)).toThrow("retained");
      expect(existsSync(file)).toBe(false);
      expect(lstatSync(`${file}.lock`).isSymbolicLink()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${family.family} handle rechecks its parents before reads and lock acquisition`, async () => {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-replaced-parent-");
    try {
      const journal = family.create(root);
      const directory = join(root, ".castloop", family.family, config.service_id);
      renameSync(directory, `${directory}-saved`);
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, directory);
      expect(() => journal.load()).toThrow("real directories");
      await expect(journal.exclusively(async () => {})).rejects.toThrow("real directories");
      expect(readdirSync(outside)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${family.family} never removes a replacement lock created during its callback`, async () => {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-replaced-lock-");
    try {
      const journal = family.create(root);
      const lock = join(root, ".castloop", family.family, config.service_id, `${family.id}.json.lock`);
      await expect(journal.exclusively(async () => {
        rmSync(lock);
        writeFileSync(lock, "replacement-owned-by-someone-else");
      })).rejects.toThrow("changed client lock");
      expect(readFileSync(lock, "utf8")).toBe("replacement-owned-by-someone-else");
      expect(family.read(root).lock_present).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("read-only parent checks do not create a workspace, and invalid directory identities cannot escape it", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-parent-missing-");
  try {
    const missing = join(root, "missing");
    ensureLocalJournalParents(missing, "staging-uploads", config.service_id);
    expect(existsSync(missing)).toBe(false);
    expect(() => ensureLocalJournalParents(missing, "staging-uploads", config.service_id, true)).toThrow("already exist");
    expect(() => ensureLocalJournalParents(root, "staging-uploads", "../outside", true)).toThrow("identity");
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
