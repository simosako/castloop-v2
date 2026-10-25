import { afterEach, expect, test } from "bun:test";
import { runSqliteCommand } from "./sqlite-commands";
import { progressResultSchema } from "./progress";
import type { ProgressResult } from "./progress";
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

function phase(result: ProgressResult, name: string) {
  return result.phases.find((entry) => entry.phase === name);
}

async function publishedShow(value: Awaited<ReturnType<typeof fixture>>) {
  await value.command("create-show", ["daily", "https://example.com/my-podcast"]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("update-show", ["daily"]);
  return await value.command("publish-show", ["daily"]) as { job_id: string; state: string };
}

test("progress merges local journals and remote status for a succeeded publication", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  const result = progressResultSchema.parse(await value.command("progress", [published.job_id]));
  expect(result.job).toMatchObject({ job_id: published.job_id, source: "publication", kind: "show", show_id: "daily" });
  expect(result.state).toBe("succeeded");
  expect(result.status?.state).toBe("succeeded");
  expect(result.observation).toMatchObject({ observed: true, stale: false });
  expect(phase(result, "input_frozen")).toMatchObject({ state: "done", evidence: "local_journal" });
  expect(phase(result, "upload:show_metadata")).toMatchObject({ state: "done" });
  expect(phase(result, "upload:cover_jpg")).toMatchObject({ state: "done" });
  expect(phase(result, "publication_submitted")).toMatchObject({ state: "done" });
  expect(phase(result, "fifo_waiting")).toMatchObject({ state: "done" });
  expect(phase(result, "executing")).toMatchObject({ state: "done" });
  expect(phase(result, "cache_purge")).toMatchObject({ state: "unknown" });
  expect(phase(result, "terminal")).toMatchObject({ state: "done", detail: "succeeded" });
  expect(result.waiting_reason).toBe(null);
});

test("progress keeps unsubmitted drafts pending without inventing progress", async () => {
  const value = await fixture();
  await value.command("create-show", ["daily", "https://example.com"]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  const staged = await value.command("update-show", ["daily"]) as { job_id: string };
  const result = progressResultSchema.parse(await value.command("progress", [staged.job_id]));
  expect(result.state).toBe("draft");
  expect(result.status).toBe(null);
  expect(phase(result, "upload:show_metadata")).toMatchObject({ state: "done" });
  expect(phase(result, "publication_submitted")).toMatchObject({ state: "pending" });
  expect(phase(result, "terminal")).toMatchObject({ state: "pending" });
  expect(result.waiting_reason).toBe(null);
});

test("progress explains FIFO waiting reasons and paused admission", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'queued' WHERE job_id = ?", published.job_id);
  const queued = progressResultSchema.parse(await value.command("progress", [published.job_id]));
  expect(queued.state).toBe("queued");
  expect(queued.waiting_reason).toMatchObject({ reason: "waiting_in_fifo" });
  expect(phase(queued, "fifo_waiting")).toMatchObject({ state: "in_progress" });
  expect(phase(queued, "terminal")).toMatchObject({ state: "pending" });
  await value.command("show-pause", ["daily", crypto.randomUUID()]);
  const paused = progressResultSchema.parse(await value.command("progress", [published.job_id]));
  expect(paused.waiting_reason).toMatchObject({ reason: "admission_paused" });
  expect(paused.observation.health_state).toBe("paused");
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'succeeded' WHERE job_id = ?", published.job_id);
  await value.command("show-delivery-resume", ["daily", crypto.randomUUID()]);
  value.storage.sql.exec("UPDATE publication_jobs SET state = 'queued' WHERE job_id = ?", published.job_id);
  const admissionPaused = progressResultSchema.parse(await value.command("progress", [published.job_id]));
  expect(admissionPaused.waiting_reason).toMatchObject({ reason: "admission_paused" });
  expect(admissionPaused.observation.health_state).toBe("admission_paused");
});

test("progress falls back to the retained local status when remote observation fails", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  const failing: R2RestTransport = async () => { throw new Error("network partition"); };
  const result = progressResultSchema.parse(await value.command("progress", [published.job_id], { transport: failing }));
  expect(result.state).toBe("succeeded");
  expect(result.observation).toMatchObject({ observed: false, stale: true });
  expect(phase(result, "terminal")).toMatchObject({ state: "done" });
});

test("progress resolves lifecycle jobs and rejects unknown identifiers", async () => {
  const value = await fixture();
  const published = await publishedShow(value);
  await value.command("create-episode", ["daily", "first"]);
  const directory = join(value.root, "daily");
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await value.command("update-episode", ["daily", "first"]);
  await value.command("update-episode-audio", ["daily", "first", "audio.mp3"]);
  await value.command("publish-episode", ["daily", "first"]);
  const plan = await value.command("preview-episode-lifecycle", ["daily", "first", "unpublish"]) as { request: { job_id: string }; request_sha256: string };
  const file = join(value.root, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  await value.command("lifecycle-execute", [file, plan.request_sha256, "confirm"]);
  const result = progressResultSchema.parse(await value.command("progress", [plan.request.job_id]));
  expect(result.job).toMatchObject({ source: "lifecycle", kind: "episode", episode_id: "first" });
  expect(result.state).toBe("succeeded");
  expect(phase(result, "publication_submitted")).toMatchObject({ state: "not_applicable" });
  expect(phase(result, "cache_purge")).toMatchObject({ state: "unknown" });
  await expect(value.command("progress", [crypto.randomUUID()])).rejects.toThrow("No matching SQLite job journal");
});
