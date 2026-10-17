import { expect, spyOn, test } from "bun:test";
import { publicationQueuedReceiptSchema, verifyPublicationCommitIntent } from "@castloop/shared";
import { createPublicationJournal, readLocalPublicationJob } from "./publication-journal";
import { createPublicationOperationEffects, inspectPublicationOperation, runPublicationClaim, runPublicationCommit, runPublicationRetry } from "./publication-operation";
import { readShowControl } from "../../../src/lifecycle-control";
import { fetchM6ManagementIntegration, queueM6Candidate } from "../../../src/m6-routes";
import { readServiceAdmission } from "../../../src/service-admission";
import { retainPublicationSubmission } from "../../../src/publication-submission-store";
import { publicationAdminFixture } from "../../../src/test-support/publication-admin";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

async function fixture(options: { send?: "lost" | "forbidden"; legacy?: boolean; unknownQueue?: boolean; unknownConsumer?: boolean } = {}) {
  const setup = await publicationAdminFixture("episode");
  const root = mkdtempSync("/tmp/opencode/castloop-queue-client-");
  const journal = createPublicationJournal(root, setup.config, setup.frozen);
  const file = join(root, ".castloop", "publication-jobs", setup.config.service_id, `${setup.frozen.request.job_id}.json`);
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID, previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = setup.config.account_id;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  const calls: string[] = [], sent: unknown[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init), url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    expect(request.redirect).toBe("error");
    if (url.hostname === "api.cloudflare.com") {
      expect(request.headers.get("Authorization")).toBe("Bearer test-token");
      expect(url.pathname.startsWith(`/client/v4/accounts/${setup.config.account_id}/queues`)).toBe(true);
      if (url.pathname.endsWith("/queues")) return Response.json({ success: true,
        result: options.unknownQueue ? [] : [{ queue_name: setup.config.queue_name, queue_id: "1".repeat(32) }] });
      if (url.pathname.endsWith(`/queues/${"1".repeat(32)}`)) return Response.json({ success: true,
        result: { queue_name: setup.config.queue_name, queue_id: "1".repeat(32) } });
      if (url.pathname.endsWith("/consumers")) return Response.json({ success: true, result: options.unknownConsumer ? [] : [{
        script_name: setup.config.worker_name, dead_letter_queue: setup.config.dlq_name, settings: { batch_size: 1, max_concurrency: 1, max_retries: 2 },
      }] });
      expect(request.method).toBe("POST");
      expect(url.pathname.endsWith(`/queues/${"1".repeat(32)}/messages`)).toBe(true);
      const body = await request.json() as { body: unknown };
      const state = journal.load();
      expect(state.phase).toBe("submit_requested");
      expect(body.body).toEqual(state.queue_submission?.intent);
      expect(await verifyPublicationCommitIntent(body.body, "private-secret")).not.toBeNull();
      expect(await setup.bucket.head(setup.markerKey)).toBeNull();
      expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
      sent.push(body.body);
      if (options.send === "lost") throw new Error("simulated response loss after sending");
      if (options.send === "forbidden") return Response.json({ success: false }, { status: 403 });
      return Response.json({ success: true });
    }
    if (url.pathname === "/admin/publication") {
      const body = await request.clone().json() as { action: string };
      expect(body.action).not.toBe("commit");
    }
    const response = await fetchM6ManagementIntegration(request as never, setup.candidateEnv, setup.cachedAssets);
    if (options.legacy && url.pathname === "/admin/service") {
      const { publication_commit_protocol: _protocol, ...value } = await response.json() as Record<string, unknown>;
      return Response.json(value);
    }
    return response;
  }, { preconnect: globalThis.fetch.preconnect }));
  const effects = createPublicationOperationEffects(setup.config, journal.load(), "private-secret");
  const consume = (body: unknown = sent[0]) => queueM6Candidate({ queue: setup.config.queue_name,
    messages: [{ id: crypto.randomUUID(), body }] } as never, setup.candidateEnv, setup.cachedAssets);
  return { ...setup, root, journal, file, effects, calls, sent, consume, dispose() {
    fetchSpy.mockRestore();
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previousToken;
    rmSync(root, { recursive: true, force: true });
  } };
}

test("default CLI freezes Queue intent before POST, returns queued without marker proof, and never uses HTTP commit", async () => {
  const setup = await fixture();
  try {
    await runPublicationClaim(setup.journal, setup.effects);
    await runPublicationCommit(setup.journal, setup.effects);
    expect(setup.journal.load()).toMatchObject({ phase: "queued", queued_receipt: { result: "queued", commit_protocol: "queue-commit-v1" } });
    expect(setup.journal.load().commit_receipt).toBeUndefined();
    expect(setup.journal.load().queued_receipt).not.toHaveProperty("key");
    expect(setup.journal.load().queued_receipt).not.toHaveProperty("created");
    expect(setup.sent).toHaveLength(1);
    expect(await setup.bucket.head(setup.markerKey)).toBeNull();
    await expect(setup.effects.commit()).rejects.toThrow("HTTP fallback");
    await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow("never replay");
    await expect(runPublicationRetry(setup.journal, setup.effects)).rejects.toThrow("unfinished held owner");
    await setup.consume();
    expect((await inspectPublicationOperation(setup.journal, setup.effects)).server_status).toMatchObject({
      ownership: "released", status: { state: "published" }, submission: { state: "completed" },
    });
    expect(readLocalPublicationJob(setup.root, setup.config, setup.frozen.request.job_id).client_state?.phase).toBe("queued");
    expect(readFileSync(setup.file, "utf8")).not.toContain("test-token");
    expect(readFileSync(setup.file, "utf8")).not.toContain("private-secret");
  } finally { setup.dispose(); }
});

for (const send of ["lost", "forbidden"] as const) test(`Queue ${send} response preserves frozen submission and owner without replay or HTTP fallback`, async () => {
  const setup = await fixture({ send });
  try {
    await runPublicationClaim(setup.journal, setup.effects);
    await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow("without replaying");
    expect(setup.journal.load().phase).toBe("submit_requested");
    const before = readFileSync(setup.file, "utf8");
    await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow("never replay");
    await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
    expect(setup.sent).toHaveLength(1);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.job_id).toBe(setup.frozen.request.job_id);
    expect(await setup.bucket.head(setup.markerKey)).toBeNull();
    if (send === "lost") {
      await setup.consume();
      expect((await inspectPublicationOperation(setup.journal, setup.effects)).server_status.status?.state).toBe("published");
    }
    expect(readFileSync(setup.file, "utf8")).toBe(before);
  } finally { setup.dispose(); }
});

for (const option of ["legacy", "unknownQueue", "unknownConsumer"] as const) test(`${option} is rejected before claim without resources or HTTP commit fallback`, async () => {
  const setup = await fixture({ [option]: true });
  try {
    const before = setup.writes.length;
    await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow();
    expect(setup.journal.load().phase).toBe("prepared");
    expect(setup.writes.length).toBe(before);
    expect(setup.sent).toEqual([]);
  } finally { setup.dispose(); }
});

test("unverified queued receipt cannot promote or replace the frozen submission", async () => {
  const setup = await fixture();
  try {
    await runPublicationClaim(setup.journal, setup.effects);
    const queue = setup.effects.queueCommit!;
    await expect(runPublicationCommit(setup.journal, { ...setup.effects, queueCommit: { ...queue,
      preflight: () => queue.preflight(), prepare: (publication) => queue.prepare(publication),
      async send(submission) { return publicationQueuedReceiptSchema.parse({ ...await queue.send(submission), submission_id: crypto.randomUUID() }); },
    } })).rejects.toThrow("differs from its frozen");
    expect(setup.journal.load().phase).toBe("submit_requested");
    await expect(setup.journal.exclusively(async () => setup.journal.save({ ...setup.journal.load(), phase: "accepted",
      queue_submission: undefined, commit_receipt: { key: setup.markerKey, created: true, acceptance_protocol: "queue-validation-v1", staging_verified: false } })))
      .rejects.toThrow("cannot change");
    expect(setup.sent).toHaveLength(1);
  } finally { setup.dispose(); }
});

test("local inputs are checked after Queue preparation and before freezing or sending its POST", async () => {
  const setup = await fixture();
  try {
    let current = true;
    const checkLocalInputs = async () => { if (!current) throw new Error("Local metadata changed during Queue preparation"); };
    await runPublicationClaim(setup.journal, { ...setup.effects, checkLocalInputs });
    const queue = setup.effects.queueCommit!;
    await expect(runPublicationCommit(setup.journal, { ...setup.effects, checkLocalInputs, queueCommit: {
      preflight: () => queue.preflight(), send: (submission) => queue.send(submission),
      async prepare(publication) { const submission = await queue.prepare(publication); current = false; return submission; },
    } })).rejects.toThrow("Local metadata changed");
    expect(setup.journal.load().phase).toBe("claimed");
    expect(setup.journal.load().queue_submission).toBeUndefined();
    expect(setup.sent).toEqual([]);
  } finally { setup.dispose(); }
});

test("existing server submission blocks another commit intent even before a marker or execution exists", async () => {
  const setup = await fixture();
  try {
    await runPublicationClaim(setup.journal, setup.effects);
    const submission = await setup.effects.queueCommit!.prepare(setup.frozen);
    await retainPublicationSubmission(setup.env, submission.intent);
    await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow("unstarted held owner");
    expect(setup.journal.load().phase).toBe("claimed");
    expect(setup.sent).toEqual([]);
  } finally { setup.dispose(); }
});
