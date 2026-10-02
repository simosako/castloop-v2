import { expect, test } from "bun:test";
import { parseEpisodeRevision, publicationAdminRequestSchema, publicationAdminResponseSchema, publicationCommitKey, publicationManifestHash,
  publicationRequestSchema, stagePayloadKey, stageUploadRequestSchema } from "@castloop/shared";
import { readShowControl } from "../../../src/lifecycle-control";
import { handleM6PublicationAdmin } from "../../../src/publication-admin";
import { queueM6Candidate } from "../../../src/m6-routes";
import { acquireShowExecution } from "../../../src/lifecycle-control";
import { SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { publicationAdminFixture } from "../../../src/test-support/publication-admin";
import { publicationTestDigest } from "../../../src/test-support/episode-publication";
import { PublicationAdminClient } from "./publication-client";
import { createPublicationJournal, readLocalPublicationJob } from "./publication-journal";
import type { PublicationJournal } from "./publication-journal";
import { createPublicationOperationEffects, inspectPublicationOperation, runPublicationClaim, runPublicationCommit, runPublicationRetry } from "./publication-operation";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture(mode: "show" | "episode" | "metadata" | "audio" = "show") {
  const setup = await publicationAdminFixture(mode);
  const root = mkdtempSync("/tmp/opencode/castloop-publication-journal-");
  const journal = createPublicationJournal(root, setup.config, setup.frozen);
  const file = join(root, ".castloop", "publication-jobs", setup.config.service_id, `${setup.frozen.request.job_id}.json`);
  const calls: string[] = [];
  const client = new PublicationAdminClient(setup.config, "private-secret", async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(new URL("/admin/publication", setup.config.public_base_url).href);
    expect(request.redirect).toBe("error");
    const body = publicationAdminRequestSchema.parse(await request.clone().json());
    calls.push(body.action);
    const response = await handleM6PublicationAdmin(request, setup.env, setup.bindings);
    if (!response) throw new Error("Expected publication internal API");
    return response;
  });
  const effects = createPublicationOperationEffects(setup.config, journal.load(), "private-secret", client);
  const consume = (key: string) => queueM6Candidate({ queue: "test-queue", messages: [{ id: "publication", body: { object: { key } } }] } as never,
    setup.candidateEnv, setup.cachedAssets, { digest: publicationTestDigest });
  return { ...setup, root, journal, file, calls, client, effects, consume };
}

for (const mode of ["show", "episode", "metadata", "audio"] as const) {
  test(`durable publication ${mode} keeps claim/commit separate and completes through M6 Queue`, async () => {
    const setup = await fixture(mode);
    const feed = setup.text(setup.feedKey);
    await runPublicationClaim(setup.journal, setup.effects);
    expect(setup.journal.load().phase).toBe("claimed");
    expect(setup.text(setup.feedKey)).toBe(feed);
    expect(await setup.bucket.head(setup.markerKey)).toBeNull();
    await runPublicationCommit(setup.journal, setup.effects);
    expect(setup.journal.load().phase).toBe("committed");
    expect(setup.journal.load().commit_receipt?.key).toBe(setup.markerKey);
    expect(setup.text(setup.feedKey)).toBe(feed);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("reserved");
    await setup.consume(setup.markerKey);
    const bytes = readFileSync(setup.file, "utf8");
    const observed = await inspectPublicationOperation(setup.journal, setup.effects);
    expect(observed.server_status.status?.state).toBe("published");
    expect(observed.server_status.progress?.purge_confirmed).toBe(true);
    expect(observed.server_status.ownership).toBe("released");
    expect(observed.server_status.staging_verified).toBe(false);
    expect(observed.server_status.authorizes_recovery).toBe(false);
    expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    if (mode !== "show") {
      const metadata = parseEpisodeRevision(setup.text("public/episodes/daily/next/metadata.toml"));
      expect(metadata.revision_id).toBe(setup.frozen.request.job_id);
      if (setup.base) {
        expect(metadata.guid).toBe(setup.base.guid);
        expect(metadata.published_at).toBe(setup.base.published_at);
        expect(await setup.bucket.head(`public/episodes/daily/next/revisions/${setup.base.revision_id}.toml`)).not.toBeNull();
        expect(await setup.bucket.head(`public${new URL(setup.base.enclosure_url).pathname}`)).not.toBeNull();
        if (mode === "metadata") expect(metadata.enclosure_url).toBe(setup.base.enclosure_url.replace("https://old.example", "https://current.example"));
      }
    }
    expect(setup.calls).toEqual(["claim", "status", "commit", "status"]);
    expect(statSync(setup.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(setup.root, ".castloop", "publication-jobs", setup.config.service_id)).mode & 0o777).toBe(0o700);
    for (const secret of ["private-secret", "Private description", "New Show title", "owner@example.com"]) expect(bytes).not.toContain(secret);
    await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
    await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow("never replay");
  });
}

test("commit rejects a changed local manifest with unchanged job/target/generation", async () => {
  const setup = await fixture("episode");
  await setup.client.claim(setup.frozen);
  const commit = setup.frozen.commit;
  if (commit.kind !== "episode") throw new Error("Expected Episode commit");
  const changed = publicationRequestSchema.parse({ ...setup.frozen, commit: { ...commit, metadata_sha256: "0".repeat(64) } });
  await expect(setup.client.commit(changed)).rejects.toThrow("response was not verified");
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.job_id).toBe(setup.frozen.request.job_id);
  expect((await setup.client.status(setup.frozen)).manifest_sha256).toBe(await publicationManifestHash(setup.frozen));
  expect(setup.calls.filter((action) => action === "commit")).toHaveLength(1);
});

for (const mode of ["show", "episode", "metadata", "audio"] as const) {
  test(`explicit same-job ${mode} retry preserves marker/media/history after purge failure`, async () => {
    const setup = await fixture(mode);
    await runPublicationClaim(setup.journal, setup.effects);
    await runPublicationCommit(setup.journal, setup.effects);
    const marker = await setup.bucket.head(setup.markerKey);
    const invalidate = setup.cachedAssets.invalidate;
    setup.cachedAssets.invalidate = async () => { throw new Error("Private purge exception"); };
    await expect(setup.consume(setup.markerKey)).rejects.toThrow();
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeUndefined();
    const before = await setup.client.status(setup.frozen);
    expect(before.ownership).toBe("held");
    expect(before.status?.state).toBe("retrying");
    const records = [setup.markerKey, `system/jobs/${setup.frozen.request.job_id}/status.toml`, `system/jobs/${setup.frozen.request.job_id}/progress.toml`];
    const old = records.map((key) => setup.text(key));
    await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, state: "paused", pause_id: crypto.randomUUID() }));
    await runPublicationRetry(setup.journal, setup.effects);
    expect(setup.journal.load().retry).toEqual({ attempt: 1, state: "requeued", key: setup.markerKey });
    expect(setup.sent).toEqual([setup.markerKey]);
    expect(records.map((key) => setup.text(key))).toEqual(old);
    expect((await setup.bucket.head(setup.markerKey))!.etag).toBe(marker!.etag);
    setup.cachedAssets.invalidate = invalidate;
    await setup.consume(setup.sent[0]!);
    expect((await setup.client.status(setup.frozen)).ownership).toBe("released");
    await expect(runPublicationRetry(setup.journal, setup.effects)).rejects.toThrow("unfinished held owner");
    await expect(setup.client.retry(setup.frozen)).rejects.toThrow("response was not verified");
    expect(setup.sent).toHaveLength(1);
    if (mode !== "show") {
      const metadata = parseEpisodeRevision(setup.text("public/episodes/daily/next/metadata.toml"));
      expect(metadata.revision_id).toBe(setup.frozen.request.job_id);
      if (setup.base) expect(await setup.bucket.head(`public/episodes/daily/next/revisions/${setup.base.revision_id}.toml`)).not.toBeNull();
    }
  });
}

test("retry requires an acknowledged commit and never steals active/unknown consumer execution", async () => {
  const setup = await fixture();
  await expect(runPublicationRetry(setup.journal, setup.effects)).rejects.toThrow("never replay");
  await setup.client.claim(setup.frozen);
  await expect(setup.client.retry(setup.frozen)).rejects.toThrow("response was not verified");
  await runPublicationClaim(setup.journal, setup.effects);
  await runPublicationCommit(setup.journal, setup.effects);
  const token = await acquireShowExecution(setup.env, "daily", setup.frozen.request.job_id, setup.publicationOperation.show_generation);
  await expect(runPublicationRetry(setup.journal, setup.effects)).rejects.toThrow("unfinished held owner");
  await expect(setup.client.retry(setup.frozen)).rejects.toThrow("response was not verified");
  expect(setup.journal.load().retry).toBeUndefined();
  expect(setup.sent).toEqual([]);
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBe(token.executionId);
});

test("unknown retry response or receipt-save failure keeps requested and observation never permits replay", async () => {
  for (const failure of ["response", "save", "queue"] as const) {
    const setup = await fixture();
    await runPublicationClaim(setup.journal, setup.effects);
    await runPublicationCommit(setup.journal, setup.effects);
    let saves = 0;
    if (failure === "queue") setup.env.CASTLOOP_QUEUE.send = async (body) => {
      setup.sent.push((body as { object: { key: string } }).object.key); throw new Error("Unknown Queue send result");
    };
    const effects = { ...setup.effects, retry: async () => {
      const value = await setup.effects.retry();
      if (failure === "response") throw new Error("Lost retry response");
      return value;
    } };
    const journal: PublicationJournal = { ...setup.journal, save: (state) => {
      if (++saves === 2 && failure === "save") throw new Error("Receipt save failed");
      setup.journal.save(state);
    } };
    await expect(runPublicationRetry(journal, effects)).rejects.toThrow();
    expect(setup.journal.load().retry).toEqual({ attempt: 1, state: "requested" });
    const bytes = readFileSync(setup.file, "utf8");
    await inspectPublicationOperation(setup.journal, setup.effects);
    expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    await expect(runPublicationRetry(setup.journal, setup.effects)).rejects.toThrow("never replay");
    expect(setup.calls.filter((action) => action === "retry")).toHaveLength(1);
    expect(setup.sent).toEqual([setup.markerKey]);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.job_id).toBe(setup.frozen.request.job_id);
    expect(bytes).not.toContain("Unknown Queue send result");
  }
});

test("known retries are explicit numbered sends; requested save must precede Queue and journal cannot skip attempts", async () => {
  const setup = await fixture();
  await runPublicationClaim(setup.journal, setup.effects);
  await runPublicationCommit(setup.journal, setup.effects);
  const journal: PublicationJournal = { ...setup.journal, save: () => { throw new Error("Disk write failed"); } };
  await expect(runPublicationRetry(journal, setup.effects)).rejects.toThrow("Disk write failed");
  expect(setup.sent).toEqual([]);
  await runPublicationRetry(setup.journal, setup.effects);
  await runPublicationRetry(setup.journal, setup.effects);
  expect(setup.sent).toEqual([setup.markerKey, setup.markerKey]);
  expect(setup.journal.load().retry?.attempt).toBe(2);
  await setup.journal.exclusively(async () => {
    const state = setup.journal.load();
    for (const retry of [undefined, { attempt: 4, state: "requested" as const }, { attempt: 2, state: "requested" as const },
      { attempt: 3, state: "requeued" as const, key: setup.markerKey }]) {
      expect(() => setup.journal.save({ ...state, retry })).toThrow();
    }
  });
});

test("false retry manifest and marker block Queue; client/runner reject foreign Episode key receipt", async () => {
  const setup = await fixture("episode");
  await runPublicationClaim(setup.journal, setup.effects);
  await runPublicationCommit(setup.journal, setup.effects);
  const commit = setup.frozen.commit;
  const changed = publicationRequestSchema.parse({ ...setup.frozen, commit: { ...commit, metadata_sha256: "0".repeat(64) } });
  await expect(setup.client.retry(changed)).rejects.toThrow("response was not verified");
  await setup.bucket.put(setup.markerKey, JSON.stringify({ ...commit, metadata_sha256: "0".repeat(64) }));
  await expect(setup.client.retry(setup.frozen)).rejects.toThrow("response was not verified");
  expect(setup.sent).toEqual([]);
  await setup.bucket.put(setup.markerKey, JSON.stringify(commit));
  const value = await setup.client.retry(setup.frozen);
  const foreign = { ...value, key: value.key.replace("/next/", "/foreign/") };
  const client = new PublicationAdminClient(setup.config, "private-secret", async () => Response.json(foreign, { headers: { "Cache-Control": "no-store" } }));
  await expect(client.retry(setup.frozen)).rejects.toThrow("response was not verified");
  await expect(runPublicationRetry(setup.journal, { ...setup.effects, retry: async () => foreign })).rejects.toThrow("receipt differs");
  expect(setup.journal.load().retry?.state).toBe("requested");
});

test("client rejects false manifest, result, identity and Episode commit-key receipts", async () => {
  const setup = await fixture("episode");
  await setup.client.claim(setup.frozen);
  const original = await setup.client.commit(setup.frozen);
  for (const value of [{ ...original, manifest_sha256: "0".repeat(64) }, { ...original, service_id: "foreign" },
    { ...original, operation: { ...original.operation, show_generation: original.operation.show_generation + 1 } },
    { ...original, key: original.key.replace("/next/", "/foreign/") },
    { ...original, result: "claimed", key: undefined, created: undefined }]) {
    let sends = 0;
    const client = new PublicationAdminClient(setup.config, "private-secret", async () => {
      sends += 1; return Response.json(value, { headers: { "Cache-Control": "no-store" } });
    });
    await expect(client.commit(setup.frozen)).rejects.toThrow("response was not verified");
    expect(sends).toBe(1);
  }
  const before = await setup.bucket.head(setup.markerKey);
  expect((await setup.client.commit(setup.frozen)).created).toBe(false);
  expect((await setup.bucket.head(setup.markerKey))!.etag).toBe(before!.etag);
});

test("client validates input identities, staging operation IDs and size bounds before any POST", async () => {
  const setup = await fixture("episode");
  let sends = 0;
  const client = new PublicationAdminClient(setup.config, "private-secret", async () => { sends += 1; throw new Error("Must not send"); });
  const commit = setup.frozen.commit;
  for (const value of [{ ...setup.frozen, request: { ...setup.frozen.request, expected_show_generation: Number.MAX_SAFE_INTEGER } },
    { ...setup.frozen, commit: { ...commit, job_id: crypto.randomUUID() } },
    { ...setup.frozen, staged_uploads: [setup.frozen.request.job_id] },
    { ...setup.frozen, commit: { ...commit, audio_length_bytes: 300000001 } },
    { ...setup.frozen, title: "Private metadata" }]) await expect(client.claim(value as never)).rejects.toThrow();
  expect(sends).toBe(0);
});

test("read-only status does not inspect payload contents or register tokens, including while paused", async () => {
  const setup = await fixture("episode");
  await setup.client.claim(setup.frozen);
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, state: "paused", pause_id: crypto.randomUUID(),
    invocations: [{ token: crypto.randomUUID(), kind: "m6_recovery" }] }));
  const writes = setup.writes.length;
  const reads = setup.bodyReads.length;
  const value = await setup.client.status(setup.frozen);
  expect(value.ownership).toBe("held");
  expect(value.marker_present).toBe(false);
  expect(value.staging_verified).toBe(false);
  expect(setup.writes.length).toBe(writes);
  expect(setup.bodyReads.slice(reads).some((key) => key.startsWith("public/") || key.startsWith("staging/"))).toBe(false);
  const service = setup.text(SERVICE_ADMISSION_KEY);
  await setup.client.status(setup.frozen);
  expect(setup.text(SERVICE_ADMISSION_KEY)).toBe(service);
});

test("partial manifest is unclaimed and active publication execution remains held during inspection", async () => {
  const setup = await fixture();
  await setup.bucket.put(`system/jobs/${setup.frozen.request.job_id}/publication.json`, JSON.stringify(setup.frozen));
  expect((await setup.client.status(setup.frozen)).ownership).toBe("unclaimed");
  await runPublicationClaim(setup.journal, setup.effects);
  await runPublicationCommit(setup.journal, setup.effects);
  const token = await acquireShowExecution(setup.env, "daily", setup.frozen.request.job_id, setup.publicationOperation.show_generation);
  const value = await setup.client.status(setup.frozen);
  expect(value.execution_active).toBe(true);
  expect(value.authorizes_recovery).toBe(false);
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBe(token.executionId);
});

test("claim/commit response loss remains requested even when remote owner/marker is visible", async () => {
  for (const action of ["claim", "commit"] as const) {
    const setup = await fixture();
    if (action === "commit") await runPublicationClaim(setup.journal, setup.effects);
    const effects = { ...setup.effects,
      claim: async () => { const result = await setup.effects.claim(); if (action === "claim") throw new Error("Lost response"); return result; },
      commit: async () => { const result = await setup.effects.commit(); if (action === "commit") throw new Error("Lost response"); return result; } };
    const run = action === "claim" ? runPublicationClaim : runPublicationCommit;
    await expect(run(setup.journal, effects)).rejects.toThrow("Lost response");
    expect(setup.journal.load().phase).toBe(action === "claim" ? "claim_requested" : "commit_requested");
    const bytes = readFileSync(setup.file, "utf8");
    expect((await inspectPublicationOperation(setup.journal, setup.effects)).server_status.ownership).toBe("held");
    expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    await expect(run(setup.journal, setup.effects)).rejects.toThrow("never replay");
    expect(setup.calls.filter((call) => call === action)).toHaveLength(1);
  }
});

test("successful POST with failed receipt save does not allow replay or phase promotion", async () => {
  for (const action of ["claim", "commit"] as const) {
    const setup = await fixture();
    if (action === "commit") await runPublicationClaim(setup.journal, setup.effects);
    let saves = 0;
    const journal: PublicationJournal = { ...setup.journal, save: (state) => {
      if (++saves === 2) throw new Error("Receipt save failed");
      setup.journal.save(state);
    } };
    const run = action === "claim" ? runPublicationClaim : runPublicationCommit;
    await expect(run(journal, setup.effects)).rejects.toThrow("Receipt save failed");
    await inspectPublicationOperation(setup.journal, setup.effects);
    await expect(run(setup.journal, setup.effects)).rejects.toThrow("never replay");
    expect(setup.calls.filter((call) => call === action)).toHaveLength(1);
  }
});

test("POST cannot precede durable requested save and fake receipts cannot advance its phase", async () => {
  const setup = await fixture();
  const journal: PublicationJournal = { ...setup.journal, save: () => { throw new Error("Disk write failed"); } };
  await expect(runPublicationClaim(journal, setup.effects)).rejects.toThrow("Disk write failed");
  expect(setup.calls).toEqual([]);
  const effects = { ...setup.effects, claim: async () => ({ ...await setup.effects.claim(), manifest_sha256: "0".repeat(64) }) };
  await expect(runPublicationClaim(setup.journal, effects)).rejects.toThrow("receipt differs");
  expect(setup.journal.load().phase).toBe("claim_requested");
  await expect(runPublicationClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
});

test("live commit keeps local lock and remaining lock is never expired or removed", async () => {
  const setup = await fixture();
  await runPublicationClaim(setup.journal, setup.effects);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const running = runPublicationCommit(setup.journal, { ...setup.effects, commit: async () => { enter(); await released; return setup.effects.commit(); } });
  await entered;
  expect(setup.journal.load().phase).toBe("commit_requested");
  expect(readLocalPublicationJob(setup.root, setup.config, setup.frozen.request.job_id).lock_present).toBe(true);
  const other = createPublicationJournal(setup.root, setup.config, setup.frozen);
  await expect(runPublicationCommit(other, setup.effects)).rejects.toThrow();
  release();
  await running;
  expect(existsSync(`${setup.file}.lock`)).toBe(false);
  writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
  await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow();
  expect(existsSync(`${setup.file}.lock`)).toBe(true);
});

test("offline inspection is non-writing and frozen identity/manifest changes are refused", async () => {
  const setup = await fixture();
  const empty = mkdtempSync("/tmp/opencode/castloop-publication-empty-");
  expect(readLocalPublicationJob(empty, setup.config, setup.frozen.request.job_id)).toEqual({ client_state: null, lock_present: false, remote_state_checked: false });
  expect(existsSync(join(empty, ".castloop"))).toBe(false);
  for (const config of [{ ...setup.config, account_id: "f".repeat(32) }, { ...setup.config, worker_name: "foreign" },
    { ...setup.config, public_base_url: "https://foreign.example" }]) {
    expect(() => readLocalPublicationJob(setup.root, config, setup.frozen.request.job_id)).toThrow("another service");
    expect(() => createPublicationOperationEffects(config, setup.journal.load(), "private-secret", setup.client)).toThrow("another service");
  }
  expect(() => createPublicationJournal(setup.root, setup.config, { ...setup.frozen, staged_uploads: [crypto.randomUUID()] })).toThrow("different frozen");
  expect(() => readLocalPublicationJob(setup.root, setup.config, "../foreign")).toThrow();
});

test("invalid/oversized records, phase skipping and altered receipts are never overwritten", async () => {
  const setup = await fixture();
  const initial = setup.journal.load();
  const bytes = readFileSync(setup.file, "utf8");
  expect(() => setup.journal.save({ ...initial, phase: "claim_requested" })).toThrow("exclusive client lock");
  await setup.journal.exclusively(async () => {
    expect(() => setup.journal.save({ ...initial, phase: "claimed", claim_receipt: setup.publicationOperation })).toThrow("skip phases");
  });
  for (const text of ["invalid-json", " ".repeat(16385), JSON.stringify({ ...initial, secret: "private-secret" }),
    JSON.stringify({ ...initial, manifest_sha256: "0".repeat(64) }), JSON.stringify({ ...initial, phase: "committed" })]) {
    writeFileSync(setup.file, text);
    expect(() => setup.journal.load()).toThrow();
    expect(() => createPublicationJournal(setup.root, setup.config, setup.frozen)).toThrow();
    expect(readFileSync(setup.file, "utf8")).toBe(text);
  }
  writeFileSync(setup.file, bytes);
  await runPublicationClaim(setup.journal, setup.effects);
  await setup.journal.exclusively(async () => {
    expect(() => setup.journal.save(initial)).toThrow("cannot change");
    expect(() => setup.journal.save({ ...setup.journal.load(), claim_receipt: { ...setup.publicationOperation, job_id: crypto.randomUUID() } })).toThrow();
  });
});

test("historical publication status remains readable after a later Show publication", async () => {
  const setup = await fixture();
  await runPublicationClaim(setup.journal, setup.effects);
  await runPublicationCommit(setup.journal, setup.effects);
  await setup.consume(setup.markerKey);
  const draftId = crypto.randomUUID();
  const upload = stageUploadRequestSchema.parse({ ...setup.stages[0]!, operation_id: crypto.randomUUID(), draft_job_id: draftId,
    expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation });
  const operation = { show_id: "daily", operation_id: upload.operation_id, show_generation: upload.expected_show_generation + 1 };
  await setup.success(setup.input("claim", { upload }));
  await setup.success(setup.input("begin", { operation }));
  for (const { asset, bytes } of setup.contents) await setup.bucket.put(stagePayloadKey(upload, asset), bytes);
  await setup.success(setup.input("settle", { operation, put_requests_settled: true, no_more_puts: true }));
  await setup.success(setup.input("finish", { operation, outcome: "staged" }));
  const next = publicationRequestSchema.parse({ ...setup.frozen,
    request: { ...setup.frozen.request, job_id: draftId, expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation },
    commit: { ...setup.frozen.commit, job_id: draftId }, staged_uploads: [upload.operation_id] });
  await setup.client.claim(next);
  await setup.client.commit(next);
  await setup.consume(publicationCommitKey(next.commit));
  const value = await setup.client.status(setup.frozen);
  expect(value.ownership).toBe("superseded");
  expect(value.status?.state).toBe("published");
  expect(value.authorizes_recovery).toBe(false);
});

test("status rejects foreign/secret/oversized or concurrently changed operational records", async () => {
  const setup = await fixture();
  await setup.client.claim(setup.frozen);
  const key = `system/jobs/${setup.frozen.request.job_id}/publication.json`;
  const original = setup.text(key);
  for (const text of [" ".repeat(16385), JSON.stringify({ ...setup.frozen, secret: "private-secret" }),
    JSON.stringify({ ...setup.frozen, commit: { ...setup.frozen.commit, metadata_sha256: "0".repeat(64) } })]) {
    await setup.bucket.put(key, text);
    await expect(setup.client.status(setup.frozen)).rejects.toThrow("response was not verified");
  }
  await setup.bucket.put(key, original);
  const head = setup.bucket.head.bind(setup.bucket);
  setup.bucket.head = async (name) => {
    if (name === key) await setup.bucket.put(key, original);
    return head(name);
  };
  await expect(setup.client.status(setup.frozen)).rejects.toThrow("response was not verified");
});

test("shared status rejects a published record without durable purge completion or false authorization", async () => {
  const setup = await fixture();
  await setup.client.claim(setup.frozen);
  await setup.client.commit(setup.frozen);
  await setup.consume(setup.markerKey);
  const value = await setup.client.status(setup.frozen);
  for (const changed of [{ ...value, authorizes_recovery: true }, { ...value, staging_verified: true },
    { ...value, progress: null }, { ...value, progress: { ...value.progress, purge_confirmed: false } },
    { ...value, status: { schema_version: 1, secret: "private-secret" } }]) {
    expect(publicationAdminResponseSchema.safeParse(changed).success).toBe(false);
  }
});

test("commit preflight does not adopt another marker or infer an unknown consumer ended", async () => {
  const setup = await fixture();
  await runPublicationClaim(setup.journal, setup.effects);
  const active = { ...setup.effects, status: async () => ({ ...await setup.effects.status(), execution_active: true }) };
  await expect(runPublicationCommit(setup.journal, active)).rejects.toThrow("active or unknown execution");
  expect(setup.journal.load().phase).toBe("claimed");
  expect(setup.calls.filter((call) => call === "commit")).toEqual([]);
  await setup.client.commit(setup.frozen);
  await expect(runPublicationCommit(setup.journal, setup.effects)).rejects.toThrow("unstarted held owner");
  expect(setup.journal.load().phase).toBe("claimed");
  expect(setup.calls.filter((call) => call === "commit")).toHaveLength(1);
});
