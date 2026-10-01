import { expect, test } from "bun:test";
import { lifecycleAdminRequestSchema } from "@castloop/shared";
import { readShowControl } from "../../../src/lifecycle-control";
import { handleM6LifecycleAdmin } from "../../../src/lifecycle-admin";
import { lifecycleAdminFixture } from "../../../src/test-support/lifecycle-admin";
import { LifecycleAdminClient } from "./lifecycle-client";
import { createLifecycleJournal, readLocalLifecycleJob } from "./lifecycle-journal";
import type { LifecycleJournal } from "./lifecycle-journal";
import { createLifecycleOperationEffects, inspectLifecycleOperation, runLifecycleClaim, runLifecycleCommit, runLifecycleRetry } from "./lifecycle-operation";
import type { LifecycleOperationEffects } from "./lifecycle-operation";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture(action: "unpublish" | "restore" | "delete" = "delete") {
  const setup = await lifecycleAdminFixture();
  if (action === "restore") await setup.execute(await setup.operationRequest("episode", "unpublish"));
  const request = await setup.operationRequest("episode", action);
  const claim = lifecycleAdminRequestSchema.parse(await setup.body("claim", request));
  if (claim.action !== "claim") throw new Error("Expected frozen claim");
  const root = mkdtempSync("/tmp/opencode/castloop-lifecycle-journal-");
  const journal = createLifecycleJournal(root, setup.config, claim);
  const calls: string[] = [];
  const client = new LifecycleAdminClient(setup.config, "private-secret", async (input, init) => {
    const request = new Request(input, init);
    const body = lifecycleAdminRequestSchema.parse(await request.clone().json());
    calls.push(body.action);
    const response = await handleM6LifecycleAdmin(request, setup.env, setup.bindings);
    if (!response) throw new Error("Expected internal lifecycle route");
    return response;
  });
  const effects = createLifecycleOperationEffects(setup.config, journal.load(), "private-secret", client);
  const file = join(root, ".castloop", "lifecycle-jobs", setup.config.service_id, `${request.job_id}.json`);
  return { ...setup, request, claim, root, journal, calls, client, effects, file };
}

for (const action of ["unpublish", "restore", "delete"] as const) {
  test(`durable ${action} journal keeps claim and commit separate and status read-only`, async () => {
    const setup = await fixture(action);
    expect(setup.journal.load().phase).toBe("prepared");
    await runLifecycleClaim(setup.journal, setup.effects);
    expect(setup.journal.load().phase).toBe("claimed");
    expect(setup.calls).toEqual(["claim"]);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.state).toBe("reserved");
    await runLifecycleCommit(setup.journal, setup.effects);
    const committed = setup.journal.load();
    expect(committed.phase).toBe("committed");
    expect(setup.calls).toEqual(["claim", "status", "commit"]);
    await setup.consume(committed.commit_receipt!.key);
    const bytes = readFileSync(setup.file, "utf8");
    const status = await inspectLifecycleOperation(setup.journal, setup.effects);
    expect(status.server_status.status?.state).toBe("completed");
    expect(status.server_status.authorizes_retry).toBe(false);
    expect(readFileSync(setup.file, "utf8")).toBe(bytes);
    await expect(runLifecycleClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
    await expect(runLifecycleCommit(setup.journal, setup.effects)).rejects.toThrow("never replay");
    await expect(runLifecycleRetry(setup.journal, setup.effects)).rejects.toThrow("unfinished owner");
    expect(setup.calls.filter((action) => action === "claim")).toHaveLength(1);
    expect(setup.calls.filter((action) => action === "commit")).toHaveLength(1);
    expect(statSync(setup.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(setup.root, ".castloop", "lifecycle-jobs", setup.config.service_id)).mode & 0o777).toBe(0o700);
    for (const secret of ["private-secret", "Private description", "New Episode title"]) expect(bytes).not.toContain(secret);
  });
}

test("claim response loss keeps requested phase even when server status observes its owner", async () => {
  const setup = await fixture();
  const uncertain: LifecycleOperationEffects = { ...setup.effects, reserve: async () => {
    await setup.effects.reserve();
    throw new Error("Lost claim response");
  } };
  await expect(runLifecycleClaim(setup.journal, uncertain)).rejects.toThrow("Lost claim");
  expect(setup.journal.load().phase).toBe("claim_requested");
  const observed = await inspectLifecycleOperation(setup.journal, setup.effects);
  expect(observed.server_status.ownership).toBe("held");
  expect(setup.journal.load().phase).toBe("claim_requested");
  await expect(runLifecycleClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
  await expect(runLifecycleCommit(setup.journal, setup.effects)).rejects.toThrow("never replay");
  expect(setup.calls).toEqual(["claim", "status"]);
});

test("commit response loss cannot be replayed or promoted by read-only marker observation", async () => {
  const setup = await fixture();
  await runLifecycleClaim(setup.journal, setup.effects);
  const uncertain = { ...setup.effects, commit: async () => {
    await setup.effects.commit();
    throw new Error("Lost commit response");
  } };
  await expect(runLifecycleCommit(setup.journal, uncertain)).rejects.toThrow("Lost commit");
  expect(setup.journal.load().phase).toBe("commit_requested");
  const observed = await inspectLifecycleOperation(setup.journal, setup.effects);
  expect(observed.server_status.marker_present).toBe(true);
  expect(setup.journal.load().phase).toBe("commit_requested");
  await expect(runLifecycleCommit(setup.journal, setup.effects)).rejects.toThrow("never replay");
  await expect(runLifecycleRetry(setup.journal, setup.effects)).rejects.toThrow("never replay");
  expect(setup.calls.filter((action) => action === "commit")).toHaveLength(1);
});

test("retry journal numbers explicit sends and holds an unknown send without automatic replay", async () => {
  const setup = await fixture();
  await runLifecycleClaim(setup.journal, setup.effects);
  await runLifecycleCommit(setup.journal, setup.effects);
  for (const attempt of [1, 2]) {
    await runLifecycleRetry(setup.journal, setup.effects);
    expect(setup.journal.load().retry).toEqual({ attempt, state: "requeued", key: setup.journal.load().commit_receipt!.key });
  }
  const uncertain = { ...setup.effects, retry: async () => {
    await setup.effects.retry();
    throw new Error("Lost retry response");
  } };
  await expect(runLifecycleRetry(setup.journal, uncertain)).rejects.toThrow("Lost retry");
  expect(setup.journal.load().retry).toEqual({ attempt: 3, state: "requested" });
  await inspectLifecycleOperation(setup.journal, setup.effects);
  await expect(runLifecycleRetry(setup.journal, setup.effects)).rejects.toThrow("never replay");
  expect(setup.calls.filter((action) => action === "retry")).toHaveLength(3);
  expect(setup.continuations).toHaveLength(3);
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeDefined();
});

test("exclusive local lock remains during live HTTP and leftover lock is never expired or removed", async () => {
  const setup = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const live = runLifecycleClaim(setup.journal, { ...setup.effects, reserve: async () => {
    enter(); await released; return setup.effects.reserve();
  } });
  await entered;
  expect(setup.journal.load().phase).toBe("claim_requested");
  expect(existsSync(`${setup.file}.lock`)).toBe(true);
  const other = createLifecycleJournal(setup.root, setup.config, setup.claim);
  await expect(runLifecycleClaim(other, setup.effects)).rejects.toThrow();
  const observed = readLocalLifecycleJob(setup.root, setup.config, setup.request.job_id);
  expect(observed.lock_present).toBe(true);
  expect(observed.remote_state_checked).toBe(false);
  release();
  await live;
  expect(existsSync(`${setup.file}.lock`)).toBe(false);
  writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
  await expect(runLifecycleCommit(setup.journal, setup.effects)).rejects.toThrow();
  expect(readLocalLifecycleJob(setup.root, setup.config, setup.request.job_id).lock_present).toBe(true);
  expect(setup.calls).toEqual(["claim"]);
});

test("offline inspection never creates files or needs credentials and rejects foreign identity", async () => {
  const setup = await fixture();
  const empty = mkdtempSync("/tmp/opencode/castloop-empty-lifecycle-");
  expect(readLocalLifecycleJob(empty, setup.config, setup.request.job_id)).toEqual({ client_state: null, lock_present: false, remote_state_checked: false });
  expect(existsSync(join(empty, ".castloop"))).toBe(false);
  for (const config of [{ ...setup.config, account_id: "f".repeat(32) }, { ...setup.config, worker_name: "foreign-worker" },
    { ...setup.config, public_base_url: "https://foreign.example" }]) {
    expect(() => readLocalLifecycleJob(setup.root, config, setup.request.job_id)).toThrow("another service");
    expect(() => createLifecycleOperationEffects(config, setup.journal.load(), "private-secret", setup.client)).toThrow("another service");
  }
  expect(() => readLocalLifecycleJob(setup.root, setup.config, "../foreign")).toThrow();
});

test("journal refuses changed input, phase skips/rollback and writes without its lock", async () => {
  const setup = await fixture();
  const state = setup.journal.load();
  expect(() => setup.journal.save({ ...state, phase: "claim_requested" })).toThrow("exclusive client lock");
  expect(() => createLifecycleJournal(setup.root, setup.config, { ...setup.claim,
    request: { ...setup.claim.request, created_at: "2026-10-02T13:00:00Z" } })).toThrow();
  await setup.journal.exclusively(async () => {
    expect(() => setup.journal.save({ ...state, phase: "claimed" })).toThrow();
    setup.journal.save({ ...state, phase: "claim_requested" });
    expect(() => setup.journal.save(state)).toThrow("cannot change");
    expect(() => setup.journal.save({ ...state, phase: "claim_requested", retry: { attempt: 1, state: "requested" } })).toThrow();
  });
  expect(setup.calls).toEqual([]);
});

test("save failures before and after POST keep fail-closed outcomes", async () => {
  for (const at of [1, 2]) {
    const setup = await fixture();
    let saves = 0;
    const journal: LifecycleJournal = { ...setup.journal, save: (state) => {
      if (++saves === at) throw new Error("Disk write failed");
      setup.journal.save(state);
    } };
    await expect(runLifecycleClaim(journal, setup.effects)).rejects.toThrow("Disk write failed");
    expect(setup.calls.filter((action) => action === "claim")).toHaveLength(at === 1 ? 0 : 1);
    expect(setup.journal.load().phase).toBe(at === 1 ? "prepared" : "claim_requested");
    if (at === 2) await expect(runLifecycleClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
  }
});

test("false receipts and mismatched effects never advance the durable phase", async () => {
  const setup = await fixture();
  const changed = { ...setup.effects, claim: { ...setup.claim, service_id: "foreign" } };
  await expect(runLifecycleClaim(setup.journal, changed)).rejects.toThrow("effects differ");
  expect(setup.calls).toEqual([]);
  const falseReceipt = { ...setup.effects, reserve: async () => {
    const value = await setup.effects.reserve();
    return { ...value, operation: { ...value.operation, job_id: crypto.randomUUID() } };
  } };
  await expect(runLifecycleClaim(setup.journal, falseReceipt)).rejects.toThrow("receipt differs");
  expect(setup.journal.load().phase).toBe("claim_requested");
  await expect(runLifecycleClaim(setup.journal, setup.effects)).rejects.toThrow("never replay");
});

test("lost durable commit/retry receipt cannot be replaced by later remote observation", async () => {
  for (const action of ["commit", "retry"] as const) {
    const setup = await fixture();
    await runLifecycleClaim(setup.journal, setup.effects);
    if (action === "retry") await runLifecycleCommit(setup.journal, setup.effects);
    let saves = 0;
    const journal: LifecycleJournal = { ...setup.journal, save: (state) => {
      if (++saves === 2) throw new Error("Receipt disk write failed");
      setup.journal.save(state);
    } };
    const run = action === "commit" ? runLifecycleCommit : runLifecycleRetry;
    await expect(run(journal, setup.effects)).rejects.toThrow("Receipt disk write failed");
    expect(setup.journal.load().phase).toBe(action === "commit" ? "commit_requested" : "committed");
    if (action === "retry") expect(setup.journal.load().retry?.state).toBe("requested");
    const before = readFileSync(setup.file, "utf8");
    expect((await inspectLifecycleOperation(setup.journal, setup.effects)).server_status.marker_present).toBe(true);
    expect(readFileSync(setup.file, "utf8")).toBe(before);
    await expect(run(setup.journal, setup.effects)).rejects.toThrow("never replay");
    expect(setup.calls.filter((call) => call === action)).toHaveLength(1);
  }
});

test("commit/retry preflight rejects active execution and retains the existing phase", async () => {
  const setup = await fixture();
  await runLifecycleClaim(setup.journal, setup.effects);
  const active: LifecycleOperationEffects = { ...setup.effects, status: async () => ({ ...await setup.effects.status(), execution_active: true }) };
  await expect(runLifecycleCommit(setup.journal, active)).rejects.toThrow("active or unknown consumer");
  expect(setup.journal.load().phase).toBe("claimed");
  await runLifecycleCommit(setup.journal, setup.effects);
  await expect(runLifecycleRetry(setup.journal, active)).rejects.toThrow("active or unknown consumer");
  expect(setup.journal.load().retry).toBeUndefined();
  expect(setup.calls.filter((action) => action === "retry")).toHaveLength(0);
});

test("invalid/oversized records and forged retry receipts are rejected without overwriting records", async () => {
  const setup = await fixture();
  const original = readFileSync(setup.file, "utf8");
  for (const text of ["not-json", " ".repeat(16385), JSON.stringify({ ...setup.journal.load(), secret: "private-secret" }),
    JSON.stringify({ ...setup.journal.load(), phase: "committed" })]) {
    writeFileSync(setup.file, text);
    expect(() => setup.journal.load()).toThrow();
    expect(() => createLifecycleJournal(setup.root, setup.config, setup.claim)).toThrow();
    expect(readFileSync(setup.file, "utf8")).toBe(text);
  }
  writeFileSync(setup.file, original);
  await runLifecycleClaim(setup.journal, setup.effects);
  await runLifecycleCommit(setup.journal, setup.effects);
  const committed = setup.journal.load();
  await setup.journal.exclusively(async () => {
    expect(() => setup.journal.save({ ...committed, retry: { attempt: 2, state: "requested" } })).toThrow("cannot change");
    setup.journal.save({ ...committed, retry: { attempt: 1, state: "requested" } });
    expect(() => setup.journal.save({ ...committed, retry: { attempt: 1, state: "requeued", key: "foreign" } })).toThrow();
    expect(() => setup.journal.save(committed)).toThrow("cannot change");
  });
  expect(setup.journal.load().retry).toEqual({ attempt: 1, state: "requested" });
});
