import { afterEach, expect, test } from "bun:test";
import { runSqliteCommand } from "./sqlite-commands";
import { diagnoseResultSchema, diagnoseShows, formatDiagnose } from "./diagnose";
import type { DiagnoseResult } from "./diagnose";
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
    { transport: value.transport, cloudflare: value.options, diagnoseOptions: { environment: {} }, ...options });
  return Object.assign(value, { command });
}

function find(result: DiagnoseResult, id: string) {
  return [...result.shared.checks, ...result.shows.flatMap((show) => show.checks)].find((entry) => entry.id === id);
}

test("diagnose classifies local, remote and cross checks for a published Show", async () => {
  const value = await fixture();
  await value.command("create-show", ["daily", "https://example.com/my-podcast"]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("update-show", ["daily"]);
  await value.command("publish-show", ["daily"]);
  const result = diagnoseResultSchema.parse(await value.command("diagnose", ["daily"]));
  expect(result.schema_version).toBe(1);
  expect(result.shows).toHaveLength(1);
  expect(find(result, "remote-identity")).toMatchObject({ scope: "remote", status: "pass", code: "runtime_matches" });
  expect(find(result, "maintenance")).toMatchObject({ status: "pass", code: "no_maintenance" });
  expect(find(result, "cf-credentials")).toMatchObject({ scope: "remote", status: "pass", code: "cf_account_readable" });
  expect(find(result, "registration")).toMatchObject({ status: "pass", code: "registered" });
  expect(find(result, "admission")).toMatchObject({ status: "pass", code: "admission_open" });
  expect(find(result, "queue")).toMatchObject({ status: "pass", code: "queue_drained" });
  expect(find(result, "target-state")).toMatchObject({ status: "pass", code: "target_published" });
  expect(find(result, "unfinished-operations")).toMatchObject({ status: "pass", code: "no_unfinished_operations" });
  expect(find(result, "local-unfinished")).toMatchObject({ scope: "local", status: "pass", code: "no_local_unfinished" });
  expect(find(result, "consistency")).toMatchObject({ scope: "cross", status: "pass", code: "job_known_remote" });
  expect(result.summary.fail).toBe(0);
  for (const entry of [...result.shared.checks, ...result.shows.flatMap((show) => show.checks)]) {
    expect(["local", "remote", "external", "cross"]).toContain(entry.scope);
    expect(entry.next_actions.length).toBeLessThanOrEqual(4);
  }
  expect(formatDiagnose(result)).toContain("Show daily:");
  expect(formatDiagnose(result)).toContain("Summary: ");
});

test("diagnose warns without failing for a paused Show with an unpublished local draft", async () => {
  const value = await fixture();
  await value.command("create-show", ["daily", "https://example.com"]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("update-show", ["daily"]);
  await value.command("show-pause", ["daily", crypto.randomUUID()]);
  const result = diagnoseResultSchema.parse(await value.command("diagnose", ["daily"]));
  expect(find(result, "admission")).toMatchObject({ status: "warn", code: "admission_paused" });
  expect(find(result, "queue")).toMatchObject({ status: "pass", code: "queue_drained" });
  expect(find(result, "target-state")).toMatchObject({ status: "warn", code: "target_draft" });
  expect(find(result, "consistency")).toMatchObject({ status: "warn", code: "draft_pending_publication" });
  expect(result.summary.fail).toBe(0);
  expect(result.summary.warn).toBeGreaterThan(0);
});

test("diagnose distinguishes a missing Show from observation failure", async () => {
  const value = await fixture();
  const result = diagnoseResultSchema.parse(await value.command("diagnose", ["ghost"]));
  expect(find(result, "registration")).toMatchObject({ status: "warn", code: "registration_missing" });
  for (const id of ["admission", "queue", "target-state", "unfinished-operations"]) {
    expect(find(result, id)).toMatchObject({ status: "not_checked", code: "show_missing" });
  }
  expect(find(result, "consistency")).toMatchObject({ status: "pass", code: "no_pending_drafts" });
  expect(result.summary.fail).toBe(0);
});

test("diagnose marks remote checks failed on transport failure without converting gaps into success", async () => {
  const value = await fixture();
  const failing: R2RestTransport = async () => { throw new Error("network partition"); };
  const result = diagnoseResultSchema.parse(await diagnoseShows(value.root, value.config, ["daily"],
    { transport: failing, cloudflare: { accountId: value.config.account_id, apiToken: "private-token", transport: failing }, environment: {} }));
  expect(find(result, "remote-identity")).toMatchObject({ status: "fail", code: "observation_unavailable" });
  expect(find(result, "maintenance")).toMatchObject({ status: "fail", code: "observation_unavailable" });
  expect(find(result, "cf-credentials")).toMatchObject({ status: "fail", code: "cf_unreachable" });
  for (const id of ["registration", "admission", "queue", "target-state", "unfinished-operations"]) {
    expect(find(result, id)).toMatchObject({ status: "fail", code: "observation_unavailable" });
  }
  expect(find(result, "local-unfinished")).toMatchObject({ status: "pass" });
  expect(result.summary.fail).toBeGreaterThan(0);
});

test("diagnose reports not_checked instead of failure when the administrator key is missing", async () => {
  const value = await sqliteServiceFixture(); values.push(value);
  const result = diagnoseResultSchema.parse(await diagnoseShows(value.root, value.config, ["daily"],
    { cloudflare: value.options, environment: {} }));
  expect(find(result, "local-state")).toMatchObject({ scope: "local", status: "warn", code: "key_unavailable" });
  expect(find(result, "remote-identity")).toMatchObject({ status: "not_checked", code: "administrator_key_unavailable" });
  expect(find(result, "maintenance")).toMatchObject({ status: "not_checked", code: "administrator_key_unavailable" });
  for (const id of ["registration", "admission", "queue", "target-state", "unfinished-operations"]) {
    expect(find(result, id)).toMatchObject({ status: "not_checked", code: "administrator_key_unavailable" });
  }
  expect(find(result, "cf-credentials")).toMatchObject({ status: "pass", code: "cf_account_readable" });
  expect(result.summary.fail).toBe(0);
});

test("diagnose keeps Cloudflare credential failures separated from Worker observation", async () => {
  const value = await fixture();
  const result = diagnoseResultSchema.parse(await diagnoseShows(value.root, value.config, ["daily"],
    { transport: value.transport, cloudflare: { accountId: value.config.account_id, apiToken: "wrong-token", transport: value.transport }, environment: {} }));
  expect(find(result, "cf-credentials")).toMatchObject({ status: "warn", code: "cf_account_forbidden" });
  expect(find(result, "remote-identity")).toMatchObject({ status: "pass", code: "runtime_matches" });
  const absent = diagnoseResultSchema.parse(await diagnoseShows(value.root, value.config, ["daily"],
    { transport: value.transport, environment: {} }));
  expect(find(absent, "cf-credentials")).toMatchObject({ status: "not_checked", code: "cf_credentials_absent" });
});

test("diagnose enforces explicit Show budgets and distinct targets", async () => {
  const value = await sqliteServiceFixture(); values.push(value);
  const six = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  await expect(diagnoseShows(value.root, value.config, six, { cloudflare: value.options, environment: {} })).rejects.toThrow("at most 5");
  const aggregated = diagnoseResultSchema.parse(await diagnoseShows(value.root, value.config, six,
    { cloudflare: value.options, maxShows: 6, environment: {} }));
  expect(aggregated.shows).toHaveLength(6);
  expect(aggregated.shows.map((show) => show.show_id)).toEqual(six);
  await expect(diagnoseShows(value.root, value.config, ["daily", "daily"], { cloudflare: value.options, environment: {} })).rejects.toThrow("distinct");
  await expect(diagnoseShows(value.root, value.config, [], { cloudflare: value.options, environment: {} })).rejects.toThrow("at least one");
  await expect(diagnoseShows(value.root, value.config, ["daily"], { maxShows: 0 })).rejects.toThrow("--max-shows");
  await expect(diagnoseShows(value.root, value.config, ["daily"], { maxShows: 21 })).rejects.toThrow("--max-shows");
  await expect(diagnoseShows(value.root, value.config, ["daily"], { maxShows: Number("nan") })).rejects.toThrow("--max-shows");
  const twentyOne = Array.from({ length: 21 }, (_, index) => `show${index + 1}`);
  await expect(diagnoseShows(value.root, value.config, twentyOne, { cloudflare: value.options, maxShows: 20, environment: {} })).rejects.toThrow("at most 20");
});

test("runSqliteCommand passes diagnose options and validates target counts", async () => {
  const value = await fixture();
  const six = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const aggregated = diagnoseResultSchema.parse(await value.command("diagnose", six, { diagnoseOptions: { maxShows: 6, environment: {} } }));
  expect(aggregated.shows).toHaveLength(6);
  await expect(value.command("diagnose", six)).rejects.toThrow("at most 5");
  expect(aggregated.summary.fail).toBe(0);
});
