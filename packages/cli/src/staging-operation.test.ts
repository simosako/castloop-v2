import { expect, test } from "bun:test";
import { stagingAdminRequestSchema } from "@castloop/shared";
import { readShowControl } from "../../../src/lifecycle-control";
import { SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { acquireStageVerification } from "../../../src/staging-verification";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { publicationTestDigest } from "../../../src/test-support/episode-publication";
import { StagingAdminClient } from "./staging-client";
import { createStagingJournal, readLocalStagingOperation } from "./staging-journal";
import type { StagingJournal } from "./staging-journal";
import { createStagingOperationEffects, inspectStagingOperation, runStagingBeginAndUpload, runStagingClaim, runStagingFinish, runStagingSettle } from "./staging-operation";
import type { StagingOperationEffects } from "./staging-operation";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const settlement = { put_requests_settled: true as const, no_more_puts: true as const };
async function fixture(kind: "show" | "audio" | "episode_metadata" = "show") {
  const setup = await stagingAdminFixture(kind);
  const root = mkdtempSync("/tmp/opencode/castloop-staging-journal-");
  const journal = createStagingJournal(root, setup.config, setup.upload);
  const file = join(root, ".castloop", "staging-uploads", setup.config.service_id, `${setup.upload.operation_id}.json`);
  const calls: string[] = [];
  const puts: string[] = [];
  const client = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    const request = new Request(input, init);
    calls.push(stagingAdminRequestSchema.parse(await request.clone().json()).action);
    const response = await handleM6StagingAdmin(request, setup.env, setup.bindings, { digest: publicationTestDigest });
    if (!response) throw new Error("Expected staging internal API");
    return response;
  });
  const effects = createStagingOperationEffects(setup.config, journal.load(), "private-secret", async (target, index) => {
    puts.push(target.key);
    await setup.bucket.put(target.key, setup.contents[index]!.bytes);
  }, client);
  return { ...setup, root, journal, file, client, calls, puts, effects };
}

for (const kind of ["show", "audio", "episode_metadata"] as const) {
  test(`durable staging ${kind} freezes each HTTP/PUT phase and keeps publication explicit`, async () => {
    const setup = await fixture(kind);
    const feed = setup.text(setup.feedKey);
    await runStagingClaim(setup.journal, setup.effects);
    expect(setup.journal.load().phase).toBe("claimed");
    expect(await runStagingBeginAndUpload(setup.journal, setup.effects)).toBe("staged");
    expect(setup.journal.load().phase).toBe("puts_settled");
    expect(setup.journal.load().acknowledged_puts).toBe(setup.upload.payloads.length);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("uploading");
    await runStagingSettle(setup.journal, setup.effects, settlement);
    await runStagingFinish(setup.journal, setup.effects);
    expect(setup.journal.load().phase).toBe("finished");
    expect(setup.journal.load().finish_receipt).toBe("staged");
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
    expect(setup.text(setup.feedKey)).toBe(feed);
    const bytes = readFileSync(setup.file, "utf8");
    const status = await inspectStagingOperation(setup.journal, setup.effects);
    expect(status.server_status.ownership).toBe("released");
    expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    expect(setup.calls).toEqual(["claim", "status", "begin", "status", "settle", "status", "finish", "status"]);
    expect(setup.puts).toHaveLength(setup.upload.payloads.length);
    expect(statSync(setup.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(setup.root, ".castloop", "staging-uploads", setup.config.service_id)).mode & 0o777).toBe(0o700);
    for (const secret of ["private-secret", "Private description", "New Show title", "owner@example.com"]) expect(bytes).not.toContain(secret);
    await expect(runStagingClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
    await expect(runStagingBeginAndUpload(setup.journal, setup.effects)).rejects.toThrow("never reopen");
  });
}

test("known PUT exception stops remaining writes, retains payload and permits explicit settled abort", async () => {
  const setup = await fixture();
  const effects: StagingOperationEffects = { ...setup.effects, put: async (target, index) => {
    await setup.effects.put(target, index);
    throw new Error("private-secret arbitrary PUT diagnostic");
  } };
  await runStagingClaim(setup.journal, effects);
  expect(await runStagingBeginAndUpload(setup.journal, effects)).toBe("aborted");
  expect(setup.puts).toHaveLength(1);
  expect(setup.journal.load().acknowledged_puts).toBe(0);
  expect(setup.journal.load().reason_code).toBe("put_failed");
  const payload = setup.puts[0]!;
  expect(await setup.bucket.head(payload)).not.toBeNull();
  await runStagingSettle(setup.journal, effects, settlement);
  await runStagingFinish(setup.journal, effects);
  expect(setup.journal.load().finish_receipt).toBe("aborted");
  expect(await setup.bucket.head(payload)).not.toBeNull();
  expect(readFileSync(setup.file, "utf8")).not.toContain("private-secret");
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
});

test("claim response loss is held even after owner observation", async () => {
  const setup = await fixture();
  const effects = { ...setup.effects, claim: async () => { await setup.effects.claim(); throw new Error("Lost claim response"); } };
  await expect(runStagingClaim(setup.journal, effects)).rejects.toThrow("Lost claim");
  expect(setup.journal.load().phase).toBe("claim_requested");
  expect((await inspectStagingOperation(setup.journal, setup.effects)).server_status.ownership).toBe("held");
  await expect(runStagingClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
  await expect(runStagingBeginAndUpload(setup.journal, setup.effects)).rejects.toThrow("never reopen");
  expect(setup.calls.filter((action) => action === "claim")).toHaveLength(1);
  expect(setup.puts).toEqual([]);
});

test("begin response loss never starts PUTs or infers termination from HEAD/status", async () => {
  const setup = await fixture();
  await runStagingClaim(setup.journal, setup.effects);
  const effects = { ...setup.effects, begin: async () => { await setup.effects.begin(); throw new Error("Lost begin response"); } };
  await expect(runStagingBeginAndUpload(setup.journal, effects)).rejects.toThrow("Lost begin");
  const bytes = readFileSync(setup.file, "utf8");
  expect(setup.journal.load().phase).toBe("begin_requested");
  const observed = await inspectStagingOperation(setup.journal, setup.effects);
  expect(observed.server_status.progress?.phase).toBe("uploading");
  expect(observed.server_status.authorizes_put).toBe(false);
  expect(readFileSync(setup.file, "utf8")).toBe(bytes);
  await expect(runStagingBeginAndUpload(setup.journal, setup.effects)).rejects.toThrow("never reopen");
  await expect(runStagingSettle(setup.journal, setup.effects, settlement)).rejects.toThrow("local PUT termination");
  expect(setup.calls.filter((action) => action === "begin")).toHaveLength(1);
  expect(setup.puts).toEqual([]);
});

test("settlement/finish response loss cannot be promoted or automatically replayed", async () => {
  for (const action of ["settle", "finish"] as const) {
    const setup = await fixture();
    await runStagingClaim(setup.journal, setup.effects);
    await runStagingBeginAndUpload(setup.journal, setup.effects);
    if (action === "finish") await runStagingSettle(setup.journal, setup.effects, settlement);
    const effects: StagingOperationEffects = { ...setup.effects,
      settle: async (input) => { const response = await setup.effects.settle(input); if (action === "settle") throw new Error("Lost response"); return response; },
      finish: async (input) => { const response = await setup.effects.finish(input); if (action === "finish") throw new Error("Lost response"); return response; } };
    const run = () => action === "settle" ? runStagingSettle(setup.journal, effects, settlement) : runStagingFinish(setup.journal, effects);
    await expect(run()).rejects.toThrow("Lost response");
    expect(setup.journal.load().phase).toBe(action === "settle" ? "settlement_requested" : "finish_requested");
    const bytes = readFileSync(setup.file, "utf8");
    expect((await inspectStagingOperation(setup.journal, setup.effects)).server_status.progress?.phase).toBe(action === "settle" ? "settled" : "finished");
    expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    await expect(run()).rejects.toThrow("never replay");
    expect(setup.calls.filter((call) => call === action)).toHaveLength(1);
  }
});

test("live PUT holds local and Show owners and prevents settlement until its promise ends", async () => {
  const setup = await fixture("audio");
  await runStagingClaim(setup.journal, setup.effects);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const running = runStagingBeginAndUpload(setup.journal, { ...setup.effects, put: async (target, index) => {
    enter(); await released; await setup.effects.put(target, index);
  } });
  await entered;
  expect(setup.journal.load().phase).toBe("puts_running");
  expect(readLocalStagingOperation(setup.root, setup.config, setup.upload.operation_id).lock_present).toBe(true);
  const other = createStagingJournal(setup.root, setup.config, setup.upload);
  await expect(runStagingSettle(other, setup.effects, settlement)).rejects.toThrow();
  expect((await inspectStagingOperation(other, setup.effects)).server_status.ownership).toBe("held");
  expect(setup.calls.filter((action) => action === "settle")).toEqual([]);
  release();
  expect(await running).toBe("staged");
  expect(setup.journal.load().phase).toBe("puts_settled");
  expect(existsSync(`${setup.file}.lock`)).toBe(false);
});

test("pause after PUT termination still permits explicit settlement and verification", async () => {
  const setup = await fixture("audio");
  await runStagingClaim(setup.journal, setup.effects);
  await runStagingBeginAndUpload(setup.journal, setup.effects);
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, state: "paused", pause_id: crypto.randomUUID() }));
  await runStagingSettle(setup.journal, setup.effects, settlement);
  await runStagingFinish(setup.journal, setup.effects);
  expect(setup.journal.load().phase).toBe("finished");
});

test("unknown verification token blocks finish without claiming it expired", async () => {
  const setup = await fixture("audio");
  await runStagingClaim(setup.journal, setup.effects);
  await runStagingBeginAndUpload(setup.journal, setup.effects);
  await runStagingSettle(setup.journal, setup.effects, settlement);
  const token = await acquireStageVerification(setup.env, { showId: "daily", operationId: setup.upload.operation_id, generation: setup.operation.show_generation });
  await expect(runStagingFinish(setup.journal, setup.effects)).rejects.toThrow("idle verification");
  expect(setup.journal.load().phase).toBe("settled");
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.verification_id).toBe(token.verificationId);
  expect(setup.calls.filter((action) => action === "finish")).toEqual([]);
});

test("save failures before begin/PUTs prevent writes and after PUTs keep the running phase", async () => {
  for (const failingPhase of ["begin_requested", "begin_acknowledged", "puts_running", "puts_settled"] as const) {
    const setup = await fixture();
    await runStagingClaim(setup.journal, setup.effects);
    const journal: StagingJournal = { ...setup.journal, save: (state) => {
      if (state.phase === failingPhase) throw new Error("Disk write failed");
      setup.journal.save(state);
    } };
    await expect(runStagingBeginAndUpload(journal, setup.effects)).rejects.toThrow("Disk write failed");
    const expected = { begin_requested: "claimed", begin_acknowledged: "begin_requested", puts_running: "begin_acknowledged", puts_settled: "puts_running" } as const;
    expect(setup.journal.load().phase).toBe(expected[failingPhase]);
    expect(setup.puts).toHaveLength(failingPhase === "puts_settled" ? 2 : 0);
    if (failingPhase !== "begin_requested") {
      await expect(runStagingBeginAndUpload(setup.journal, setup.effects)).rejects.toThrow("never reopen");
      await expect(runStagingSettle(setup.journal, setup.effects, settlement)).rejects.toThrow("local PUT termination");
    }
  }
});

test("receipt save failures for claim/settlement/finish remain requested despite remote success", async () => {
  for (const action of ["claim", "settle", "finish"] as const) {
    const setup = await fixture("audio");
    if (action !== "claim") {
      await runStagingClaim(setup.journal, setup.effects);
      await runStagingBeginAndUpload(setup.journal, setup.effects);
    }
    if (action === "finish") await runStagingSettle(setup.journal, setup.effects, settlement);
    let saves = 0;
    const journal: StagingJournal = { ...setup.journal, save: (state) => {
      if (++saves === 2) throw new Error("Receipt save failed");
      setup.journal.save(state);
    } };
    const run = () => action === "claim" ? runStagingClaim(journal, setup.effects) :
      action === "settle" ? runStagingSettle(journal, setup.effects, settlement) : runStagingFinish(journal, setup.effects);
    await expect(run()).rejects.toThrow("Receipt save failed");
    expect(setup.journal.load().phase).toBe(action === "claim" ? "claim_requested" : action === "settle" ? "settlement_requested" : "finish_requested");
    await inspectStagingOperation(setup.journal, setup.effects);
    await expect(run()).rejects.toThrow("never replay");
    expect(setup.calls.filter((call) => call === action)).toHaveLength(1);
  }
});

test("false begin proof never starts PUTs or sends a termination assertion", async () => {
  const setup = await fixture();
  await runStagingClaim(setup.journal, setup.effects);
  const effects = { ...setup.effects, begin: async () => {
    const value = await setup.effects.begin();
    return { ...value, payloads: value.payloads.map((target) => ({ ...target, sha256: "0".repeat(64) })) };
  } };
  await expect(runStagingBeginAndUpload(setup.journal, effects)).rejects.toThrow("receipt differs");
  expect(setup.journal.load().phase).toBe("begin_requested");
  expect(setup.puts).toEqual([]);
  expect(setup.calls.filter((action) => action === "settle")).toEqual([]);
});

test("explicit settlement cannot precede PUT termination or omit no-further-PUT confirmation", async () => {
  const setup = await fixture("audio");
  await runStagingClaim(setup.journal, setup.effects);
  await expect(runStagingSettle(setup.journal, setup.effects, settlement)).rejects.toThrow("local PUT termination");
  await runStagingBeginAndUpload(setup.journal, setup.effects);
  await expect(runStagingSettle(setup.journal, setup.effects, { put_requests_settled: true } as never)).rejects.toThrow();
  expect(setup.journal.load().phase).toBe("puts_settled");
  expect(setup.calls.filter((action) => action === "settle")).toEqual([]);
});

test("offline inspection is non-writing and leftover local lock is preserved", async () => {
  const setup = await fixture();
  const empty = mkdtempSync("/tmp/opencode/castloop-staging-empty-");
  expect(readLocalStagingOperation(empty, setup.config, setup.upload.operation_id)).toEqual({ client_state: null, lock_present: false, remote_state_checked: false });
  expect(existsSync(join(empty, ".castloop"))).toBe(false);
  writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
  expect(readLocalStagingOperation(setup.root, setup.config, setup.upload.operation_id).lock_present).toBe(true);
  await expect(runStagingClaim(setup.journal, setup.effects)).rejects.toThrow();
  expect(existsSync(`${setup.file}.lock`)).toBe(true);
  expect(setup.calls).toEqual([]);
  expect(() => readLocalStagingOperation(setup.root, setup.config, "../foreign")).toThrow();
});

test("journal refuses foreign config, changed manifest, phase skipping and invalid records", async () => {
  const setup = await fixture();
  const initial = setup.journal.load();
  const bytes = readFileSync(setup.file, "utf8");
  for (const config of [{ ...setup.config, account_id: "f".repeat(32) }, { ...setup.config, worker_name: "foreign" },
    { ...setup.config, public_base_url: "https://foreign.example" }]) {
    expect(() => readLocalStagingOperation(setup.root, config, setup.upload.operation_id)).toThrow("another service");
    expect(() => createStagingOperationEffects(config, initial, "private-secret", setup.effects.put, setup.client)).toThrow("another service");
  }
  expect(() => createStagingJournal(setup.root, setup.config, { ...setup.upload, draft_job_id: crypto.randomUUID() })).toThrow("different frozen");
  expect(() => setup.journal.save({ ...initial, phase: "claim_requested" })).toThrow("exclusive client lock");
  await setup.journal.exclusively(async () => {
    expect(() => setup.journal.save({ ...initial, phase: "claimed", claim_receipt: setup.operation })).toThrow("skip phases");
  });
  for (const text of ["invalid-json", " ".repeat(16385), JSON.stringify({ ...initial, secret: "private-secret" }),
    JSON.stringify({ ...initial, phase: "finished" })]) {
    writeFileSync(setup.file, text);
    expect(() => setup.journal.load()).toThrow();
    expect(() => createStagingJournal(setup.root, setup.config, setup.upload)).toThrow();
    expect(readFileSync(setup.file, "utf8")).toBe(text);
  }
  writeFileSync(setup.file, bytes);
  await runStagingClaim(setup.journal, setup.effects);
  await runStagingBeginAndUpload(setup.journal, setup.effects);
  await setup.journal.exclusively(async () => {
    expect(() => setup.journal.save({ ...setup.journal.load(), phase: "claimed" })).toThrow();
    expect(() => setup.journal.save({ ...setup.journal.load(), put_outcome: "aborted", acknowledged_puts: 0, reason_code: "put_failed" })).toThrow("cannot change");
  });
});
