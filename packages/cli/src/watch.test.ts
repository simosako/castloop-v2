import { afterEach, expect, test } from "bun:test";
import { runSqliteCommand } from "./sqlite-commands";
import { watchExitCode, watchResultSchema, watchSqliteJob, WATCH_MAX_POLLS } from "./watch";
import type { WatchEvent, WatchResult } from "./watch";
import { agentEnvelope } from "./agent-output";
import { initializeSqliteService } from "./sqlite-initialization";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import type { R2RestTransport } from "./verified-r2-put";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });

async function fixture() {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, { attempts: 2, delay: async () => {} });
  const command = (name: string, args: string[] = [], options: Parameters<typeof runSqliteCommand>[4] = {}) => runSqliteCommand(value.root, value.config, name, args,
    { transport: value.transport, cloudflare: value.options, ...options });
  return Object.assign(value, { command });
}

async function publishedShow(value: Awaited<ReturnType<typeof fixture>>) {
  await value.command("create-show", ["daily", "https://example.com/my-podcast"]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("update-show", ["daily"]);
  return await value.command("publish-show", ["daily"]) as { job_id: string; state: string };
}

test("watch observes a terminal job once and points to verify", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  const events: WatchEvent[] = [];
  const result = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, published.job_id,
    { transport: value.transport, timeoutSeconds: 10, intervalSeconds: 1, delay: async () => {}, onEvent: (event) => events.push(event) }));
  expect(result.outcome).toEqual({ state: "succeeded" });
  expect(result.observation).toMatchObject({ polls: 1, gaps: 0, ever_observed: true });
  expect(result.next_actions).toEqual([{ action: "verify_delivery", command: "verify", args: ["daily"] }]);
  expect(watchExitCode(result)).toBe(0);
  expect(events.filter((event) => !event.gap)).toHaveLength(1);
});

test("watch reports budget exhaustion for a job that never terminates", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'queued' WHERE job_id = ?", published.job_id);
  const result = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, published.job_id,
    { transport: value.transport, timeoutSeconds: 3600, intervalSeconds: 1, delay: async () => {} }));
  expect(result.outcome).toMatchObject({ state: "unobservable", reason_code: "budget_exhausted" });
  expect(result.observation.polls).toBe(WATCH_MAX_POLLS);
  expect(result.observation.ever_observed).toBe(true);
  expect(watchExitCode(result)).toBe(2);
  expect(result.next_actions).toEqual([{ action: "observe_same_job", command: "progress", args: [published.job_id] }]);
});

test("watch treats a job that disappears after observation as missing", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'queued' WHERE job_id = ?", published.job_id);
  let deleted = false;
  const result = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, published.job_id,
    { transport: value.transport, timeoutSeconds: 10, intervalSeconds: 1, delay: async () => {},
      onEvent: (event) => {
        if (event.state === "queued" && !deleted && !event.gap) {
          deleted = true;
          value.storage.sql.exec("DELETE FROM publication_jobs WHERE job_id = ?", published.job_id);
        }
      } }));
  expect(result.outcome).toMatchObject({ state: "unobservable", reason_code: "job_missing" });
  expect(result.observation.ever_observed).toBe(true);
  expect(watchExitCode(result)).toBe(2);
});

test("watch observes blocked jobs as terminal without resolving them", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'blocked', reason_code = 'execution_failed' WHERE job_id = ?", published.job_id);
  const result = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, published.job_id,
    { transport: value.transport, timeoutSeconds: 10, intervalSeconds: 1, delay: async () => {} }));
  expect(result.outcome).toEqual({ state: "blocked", reason_code: "execution_failed" });
  expect(watchExitCode(result)).toBe(1);
  expect(result.next_actions.some((action) => action.action === "preserve_records_and_inspect")).toBe(true);
});

test("watch rejects unsubmitted drafts, unknown jobs and invalid budgets", async () => {
  const value = await fixture();
  await value.command("create-show", ["daily", "https://example.com"]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  const staged = await value.command("update-show", ["daily"]) as { job_id: string };
  const draft = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, staged.job_id,
    { transport: value.transport, timeoutSeconds: 5, intervalSeconds: 1, delay: async () => {} }));
  expect(draft.outcome).toMatchObject({ state: "unobservable", reason_code: "job_not_submitted" });
  await expect(watchSqliteJob(value.root, value.config, crypto.randomUUID(), { transport: value.transport })).rejects.toThrow("No matching SQLite job journal");
  await expect(watchSqliteJob(value.root, value.config, staged.job_id, { timeoutSeconds: 0 })).rejects.toThrow();
  await expect(watchSqliteJob(value.root, value.config, staged.job_id, { intervalSeconds: 61 })).rejects.toThrow();
});

test("watch records observation gaps without converting them into an outcome", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'queued' WHERE job_id = ?", published.job_id);
  let remaining = 3;
  const flaky: R2RestTransport = async (input, init) => {
    if (remaining > 0) { remaining -= 1; throw new Error("transient partition"); }
    return value.transport(input, init);
  };
  const result = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, published.job_id,
    { transport: flaky, timeoutSeconds: 5, intervalSeconds: 1, delay: async () => {} }));
  expect(result.observation.gaps).toBe(1);
  expect(result.status?.state).toBe("queued");
  expect(result.outcome).toMatchObject({ state: "unobservable" });
  const interrupted = watchResultSchema.parse(await watchSqliteJob(value.root, value.config, published.job_id,
    { transport: value.transport, timeoutSeconds: 5, intervalSeconds: 1, delay: async () => {}, signal: AbortSignal.abort() }));
  expect(interrupted.outcome).toMatchObject({ state: "unobservable", reason_code: "interrupted" });
});

test("watch result drives the agent envelope next_actions", () => {
  const result: WatchResult = watchResultSchema.parse({ schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily",
    outcome: { state: "succeeded" }, status: null,
    observation: { polls: 1, gaps: 0, ever_observed: true, last_observed_at: null, budget: { timeout_seconds: 600, interval_seconds: 5 } },
    next_actions: [{ action: "verify_delivery", command: "verify", args: ["daily"] }], snapshot_only: true });
  const envelope = agentEnvelope("watch", {}, result);
  expect(envelope.next_actions).toEqual([{ action: "verify_delivery", command: "verify", args: ["daily"] }]);
});
