import { z } from "zod";
import { diagnosticCheckSchema, diagnosticSummarySchema, sqliteServiceConfigHash, sqliteServiceConfigSchema, validateId } from "@castloop/shared";
import type { DiagnosticCheck, DiagnosticSummary, SqliteServiceConfig } from "@castloop/shared";
import { sqliteHealthSchema } from "../../shared/src/sqlite-service-api";
import type { SqliteHealth } from "../../shared/src/sqlite-service-api";
import { AgentError } from "./agent-output";
import { administratorKey } from "./administrator-key";
import { diagnoseLocal } from "./doctor";
import { collectStreamBytes } from "./bounded-http-read";
import { readSqliteManagementGet } from "./sqlite-management-http";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqliteOperationClient } from "./sqlite-operation-client";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { localRecords } from "./sqlite-operation-commands";
import { readSqliteDraftRecord } from "./sqlite-draft-journal";
import type { SqliteDraftRecord } from "./sqlite-draft-journal";
import { completedDomainConfiguration } from "./sqlite-domain-local";
import { collectDeliveryChecks } from "./verify";
import { ensureLocalJournalParents } from "./local-journal-path";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const DIAGNOSE_DEFAULT_MAX_SHOWS = 5;
export const DIAGNOSE_ABSOLUTE_MAX_SHOWS = 20;
const LOCAL_DOCTOR_CHECKS = new Set(["workspace", "local-state", "credentials", "account-target", "domain-records"]);
const LOCAL_TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled", "completed", "attached", "attached,attached", "registered"]);

const diagnoseShowResultSchema = z.object({ show_id: z.string().max(32), checks: z.array(diagnosticCheckSchema).max(12),
  summary: diagnosticSummarySchema }).strict();
export const diagnoseResultSchema = z.object({ schema_version: z.literal(1),
  shared: z.object({ checks: z.array(diagnosticCheckSchema).max(12), summary: diagnosticSummarySchema }).strict(),
  shows: z.array(diagnoseShowResultSchema).max(DIAGNOSE_ABSOLUTE_MAX_SHOWS), summary: diagnosticSummarySchema }).strict();
export type DiagnoseResult = z.infer<typeof diagnoseResultSchema>;
export type DiagnoseShowResult = z.infer<typeof diagnoseShowResultSchema>;

type DiagnoseOptions = { maxShows?: number; external?: boolean; transport?: R2RestTransport; cloudflare?: R2RestOptions;
  environment?: Readonly<Record<string, string | undefined>> };
type RemoteState = "available" | "unavailable" | "key_missing";

function check(id: string, scope: DiagnosticCheck["scope"], status: DiagnosticCheck["status"], code: string,
  message: string, next_actions: string[] = []): DiagnosticCheck {
  return { id, scope, status, code, message, next_actions };
}

function summarize(checks: DiagnosticCheck[]): DiagnosticSummary {
  const summary = { pass: 0, warn: 0, fail: 0, not_checked: 0 };
  for (const entry of checks) summary[entry.status] += 1;
  return summary;
}

async function cfCredentialsCheck(config: SqliteServiceConfig, options: DiagnoseOptions): Promise<DiagnosticCheck> {
  const accountId = options.cloudflare?.accountId, token = options.cloudflare?.apiToken;
  if (!accountId || !token) {
    return check("cf-credentials", "remote", "not_checked", "cf_credentials_absent",
      "Cloudflare credentials are not set; token validity was not checked");
  }
  let response: Response;
  try {
    response = await (options.cloudflare?.transport ?? options.transport ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`,
      { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch {
    return check("cf-credentials", "remote", "fail", "cf_unreachable",
      "The Cloudflare API was unreachable; token validity is unknown");
  }
  if (response.status === 403) {
    await response.body?.cancel();
    return check("cf-credentials", "remote", "warn", "cf_account_forbidden",
      "The token appears valid but cannot read the configured account; inspect its permission scopes");
  }
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel();
    return check("cf-credentials", "remote", "fail", "cf_token_invalid",
      "The Cloudflare API rejected the configured token");
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    return check("cf-credentials", "remote", "fail", "cf_unverified",
      "The Cloudflare account response was not verifiable");
  }
  try {
    const bytes = await collectStreamBytes(response.body, 1_000_000);
    const value = z.object({ success: z.literal(true), result: z.object({ id: z.string() }) })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
    if (value.result.id !== accountId) throw new Error("Cloudflare account differs");
    return check("cf-credentials", "remote", "pass", "cf_account_readable",
      "The API token is valid and can read the configured account; operation permissions are not proven");
  } catch {
    return check("cf-credentials", "remote", "fail", "cf_unverified",
      "The Cloudflare account response was not verifiable");
  }
}

async function readServiceHealth(config: SqliteServiceConfig, key: string,
  options: DiagnoseOptions): Promise<{ health: SqliteHealth | null; identityMismatch: boolean }> {
  try {
    const value = await readSqliteManagementGet(new URL("/admin/sqlite-service/health", config.workers_dev_base_url),
      { "X-Castloop-Key": key }, { transport: options.transport });
    const health = sqliteHealthSchema.parse(value);
    if (health.service_id !== config.service_id || health.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
      return { health: null, identityMismatch: true };
    }
    return { health, identityMismatch: false };
  } catch {
    return { health: null, identityMismatch: false };
  }
}

async function localDrafts(root: string, config: SqliteServiceConfig, showId: string): Promise<SqliteDraftRecord[]> {
  const drafts: SqliteDraftRecord[] = [];
  const showDraft = await readSqliteDraftRecord(root, config, { kind: "show", show_id: showId }, true);
  if (showDraft) drafts.push(showDraft);
  ensureLocalJournalParents(root, "sqlite-drafts", config.service_id);
  let names: string[] = [];
  try {
    names = readdirSync(join(root, ".castloop", "sqlite-drafts", config.service_id)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (names.length > 10000) throw new Error("Local draft lookup exceeds its record budget");
  const prefix = `episode-${showId.length}-${showId}-`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const episodeId = validateId(name.slice(prefix.length, -5), "episode");
    const record = await readSqliteDraftRecord(root, config, { kind: "episode", show_id: showId, episode_id: episodeId }, true);
    if (record) drafts.push(record);
  }
  return drafts;
}

async function consistencyCheck(root: string, config: SqliteServiceConfig, showId: string, key: string,
  remote: RemoteState, options: DiagnoseOptions): Promise<DiagnosticCheck> {
  if (remote === "key_missing") {
    return check("consistency", "cross", "not_checked", "administrator_key_unavailable",
      "The administrator key is unavailable; local/remote consistency was not checked");
  }
  let drafts: SqliteDraftRecord[];
  try { drafts = await localDrafts(root, config, showId); }
  catch {
    return check("consistency", "cross", "fail", "local_record_identity_mismatch",
      "A local draft journal differs from the current configuration; preserve it and inspect it locally",
      ["operation_status_local"]);
  }
  const frozen = drafts.filter((draft) => draft.publication);
  const pending = drafts.length - frozen.length;
  if (!frozen.length && !pending) {
    return check("consistency", "cross", "pass", "no_pending_drafts", "No unpublished local drafts for this Show");
  }
  if (remote === "unavailable") {
    return check("consistency", "cross", "fail", "observation_unavailable",
      "Local drafts exist but the remote runtime was not verifiable", ["inspect_service_status"]);
  }
  const currentHash = await sqliteServiceConfigHash(config);
  for (const draft of frozen) {
    const draftConfig = draft.service_config_sha256 === currentHash ? config :
      await completedDomainConfiguration(root, config, draft.service_config_sha256);
    if (!draftConfig) {
      return check("consistency", "cross", "fail", "local_record_identity_mismatch",
        "A frozen publication belongs to an unverifiable configuration; preserve it without replaying",
        ["preserve_records_and_inspect"]);
    }
    try {
      const status = await new SqlitePublicationClient(draftConfig, key, options.transport).observe(draft.publication!.request);
      if (!status) {
        return draft.publication!.status
          ? check("consistency", "cross", "fail", "frozen_request_missing",
            "A frozen publication request is missing remotely; preserve its records without replaying", ["preserve_records_and_inspect"])
          : check("consistency", "cross", "warn", "submission_outcome_unknown",
            "A frozen publication request has no retained or remote status; preserve it without resubmitting", ["preserve_records_and_inspect"]);
      }
    } catch {
      return check("consistency", "cross", "fail", "observation_unavailable",
        "A frozen publication could not be observed remotely", ["observe_same_job"]);
    }
  }
  if (frozen.length) {
    return check("consistency", "cross", "pass", "job_known_remote",
      `${frozen.length} frozen publication request(s) match remote job records`);
  }
  return check("consistency", "cross", "warn", "draft_pending_publication",
    `${pending} local draft(s) await explicit publication`, ["preview_before_publish"]);
}

async function diagnoseShow(root: string, config: SqliteServiceConfig, showId: string, key: string | null,
  remote: RemoteState, options: DiagnoseOptions): Promise<DiagnoseShowResult> {
  const checks: DiagnosticCheck[] = [];
  const incomplete = localRecords(root, config)
    .filter((record) => record.show_id === showId && !LOCAL_TERMINAL_OPERATION_STATES.has(record.state));
  checks.push(incomplete.length
    ? check("local-unfinished", "local", "warn", "local_unfinished_operations",
      `${incomplete.length} unfinished local operation record(s) for this Show`, ["operation_status_local"])
    : check("local-unfinished", "local", "pass", "no_local_unfinished",
      "No unfinished local operation records for this Show"));
  if (remote === "key_missing" || remote === "unavailable") {
    const status = remote === "key_missing" ? "not_checked" : "fail";
    const code = remote === "key_missing" ? "administrator_key_unavailable" : "observation_unavailable";
    const message = remote === "key_missing"
      ? "The administrator key is unavailable; remote Show checks were skipped"
      : "The remote runtime was not verifiable; Show remote checks were not attempted";
    for (const id of ["registration", "admission", "queue", "target-state", "unfinished-operations"]) {
      checks.push(check(id, "remote", status, code, message, remote === "unavailable" ? ["inspect_service_status"] : []));
    }
  } else {
    const client = new SqliteServiceClient(config, key!, options.transport);
    let registration: { state: "missing" | "requested" | "registered" } | null = null;
    try { registration = await client.registration(showId); } catch { registration = null; }
    checks.push(registration
      ? registration.state === "registered"
        ? check("registration", "remote", "pass", "registered", "The Show is registered on the server")
        : check("registration", "remote", "warn", registration.state === "missing" ? "registration_missing" : "registration_pending",
          `The Show registration is ${registration.state} on the server`)
      : check("registration", "remote", "fail", "observation_unavailable",
        "The Show registration was not observable", ["inspect_service_status"]));
    if (registration?.state !== "registered") {
      const [status, code] = registration === null ? ["fail", "observation_unavailable"] as const :
        registration.state === "requested" ? ["not_checked", "show_registration_pending"] as const : ["not_checked", "show_missing"] as const;
      const message = registration === null ? "Show-dependent remote checks were not observable" :
        registration.state === "requested" ? "Show registration has not completed; dependent checks were skipped" :
          "The Show is missing on the server; dependent checks were skipped";
      for (const id of ["admission", "queue", "target-state", "unfinished-operations"]) {
        checks.push(check(id, "remote", status, code, message));
      }
    } else {
      let health: SqliteHealth | null = null;
      try { health = await client.health(showId); } catch { health = null; }
      checks.push(health
        ? health.state === "open" && health.publication_ready
          ? check("admission", "remote", "pass", "admission_open", "Show admission is open and publication-ready")
          : health.state === "paused"
            ? check("admission", "remote", "warn", "admission_paused", "Show is paused; admission and delivery are suspended")
            : check("admission", "remote", "warn", "not_publication_ready", "Show admission is not publication-ready")
        : check("admission", "remote", "fail", "observation_unavailable", "Show health was not observable"));
      checks.push(health
        ? health.active === "blocked"
          ? check("queue", "remote", "fail", "active_blocked",
            "The active job is blocked; inspect the retained job without releasing it", ["observe_same_job"])
          : health.active === "running"
            ? check("queue", "remote", "warn", "active_running", "A job is currently running")
            : health.queued > 0
              ? check("queue", "remote", "warn", "jobs_queued", `${health.queued} job(s) are waiting in the Show FIFO`)
              : check("queue", "remote", "pass", "queue_drained", "The Show FIFO is idle and drained")
        : check("queue", "remote", "fail", "observation_unavailable", "Show queue state was not observable"));
      try {
        const inspection = await client.inspect(showId);
        checks.push(inspection.show_lifecycle === "published"
          ? check("target-state", "remote", "pass", "target_published", "The Show is published")
          : inspection.show_lifecycle === "missing"
            ? check("target-state", "remote", "fail", "target_missing", "The Show target is missing on the server")
            : check("target-state", "remote", "warn", `target_${inspection.show_lifecycle}`,
              `The Show lifecycle is ${inspection.show_lifecycle} on the server`));
      } catch {
        checks.push(check("target-state", "remote", "fail", "observation_unavailable", "The Show target was not observable"));
      }
      try {
        const operations = await new SqliteOperationClient(config, key!, options.transport, showId).list({ incomplete: true });
        checks.push(operations.operations.length
          ? check("unfinished-operations", "remote", "warn", "unfinished_operations",
            `${operations.operations.length} unfinished operation(s) on the server`, ["operation_status_remote"])
          : check("unfinished-operations", "remote", "pass", "no_unfinished_operations",
            "No unfinished server operations for this Show"));
      } catch {
        checks.push(check("unfinished-operations", "remote", "fail", "observation_unavailable",
          "Server operations were not observable"));
      }
    }
  }
  checks.push(await consistencyCheck(root, config, showId, key ?? "", remote, options));
  return { show_id: showId, checks, summary: summarize(checks) };
}

export async function diagnoseShows(root: string, input: SqliteServiceConfig, showIds: string[],
  options: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const config = sqliteServiceConfigSchema.parse(input);
  const maxShows = options.maxShows ?? DIAGNOSE_DEFAULT_MAX_SHOWS;
  if (!Number.isSafeInteger(maxShows) || maxShows < 1 || maxShows > DIAGNOSE_ABSOLUTE_MAX_SHOWS) {
    throw new AgentError("invalid_arguments", `--max-shows must be an integer between 1 and ${DIAGNOSE_ABSOLUTE_MAX_SHOWS}`);
  }
  const ids = showIds.map((id) => validateId(id, "show"));
  if (!ids.length) throw new AgentError("invalid_arguments", "diagnose requires at least one Show ID");
  if (new Set(ids).size !== ids.length) throw new AgentError("invalid_arguments", "diagnose requires distinct Show IDs");
  if (ids.length > maxShows) {
    throw new AgentError("invalid_arguments",
      `diagnose accepts at most ${maxShows} Show(s) per invocation; split the request or raise --max-shows up to ${DIAGNOSE_ABSOLUTE_MAX_SHOWS}`);
  }
  const doctor = await diagnoseLocal(root, options.environment ?? process.env);
  const shared: DiagnosticCheck[] = doctor.checks.filter((entry) => LOCAL_DOCTOR_CHECKS.has(entry.id));
  let key: string | null = null;
  try { key = administratorKey(root); } catch { key = null; }
  const remote: RemoteState = key === null ? "key_missing" : "available";
  let health: SqliteHealth | null = null;
  if (key !== null) {
    const observed = await readServiceHealth(config, key, options);
    health = observed.health;
    if (observed.identityMismatch) {
      shared.push(check("remote-identity", "remote", "fail", "runtime_differs",
        "The remote runtime identity differs from the local configuration; do not change resources", ["confirm_workspace_and_environment"]));
    } else if (health) {
      shared.push(check("remote-identity", "remote", "pass", "runtime_matches",
        "The service runtime matches the local configuration"));
    } else {
      shared.push(check("remote-identity", "remote", "fail", "observation_unavailable",
        "The service health endpoint was not observable", ["inspect_service_status"]));
    }
    if (health) {
      const maintenance = health.maintenance ? "maintenance_active" : health.runtime_update ? "runtime_update_active" :
        health.setup && health.setup.state !== "ready" ? "setup_active" : null;
      shared.push(maintenance
        ? check("maintenance", "remote", "warn", maintenance,
          `Shared service maintenance is in progress (${maintenance}); Show admission may be constrained`)
        : check("maintenance", "remote", "pass", "no_maintenance",
          "No shared maintenance, runtime update or setup is in progress"));
    } else {
      shared.push(check("maintenance", "remote", "fail", "observation_unavailable",
        "Shared maintenance state was not observable", ["inspect_service_status"]));
    }
  } else {
    shared.push(check("remote-identity", "remote", "not_checked", "administrator_key_unavailable",
      "The administrator key is unavailable; remote checks were skipped"));
    shared.push(check("maintenance", "remote", "not_checked", "administrator_key_unavailable",
      "The administrator key is unavailable; maintenance was not checked"));
  }
  shared.push(await cfCredentialsCheck(config, options));
  const remoteState: RemoteState = remote === "key_missing" ? "key_missing" : health ? "available" : "unavailable";
  const shows: DiagnoseShowResult[] = [];
  for (const showId of ids) shows.push(await diagnoseShow(root, config, showId, key, remoteState, options));
  if (options.external) {
    for (const show of shows) {
      try {
        const delivery = await collectDeliveryChecks(root, config, show.show_id, undefined, options.transport);
        const failed = delivery.checks.filter((entry) => entry.status === "fail").map((entry) => entry.code);
        const warned = delivery.checks.filter((entry) => entry.status === "warn").map((entry) => entry.code);
        show.checks.push(failed.length
          ? check("delivery", "external", "fail", "delivery_verification_failed",
            `External delivery checks failed: ${failed.join(", ")}`, ["verify_show"])
          : warned.length
            ? check("delivery", "external", "warn", "delivery_warn",
              `External delivery checks reported warnings: ${warned.join(", ")}`, ["verify_show"])
            : check("delivery", "external", "pass", "delivery_verified", "External delivery checks passed"));
      } catch {
        show.checks.push(check("delivery", "external", "fail", "delivery_observation_unavailable",
          "External delivery checks could not be performed", ["verify_show"]));
      }
      show.summary = summarize(show.checks);
    }
  }
  const all = [...shared, ...shows.flatMap((show) => show.checks)];
  return diagnoseResultSchema.parse({ schema_version: 1,
    shared: { checks: shared, summary: summarize(shared) }, shows, summary: summarize(all) });
}

export function formatDiagnose(result: DiagnoseResult): string {
  const labels = { pass: "PASS", warn: "WARN", fail: "FAIL", not_checked: "SKIP" } as const;
  const line = (entry: DiagnosticCheck) =>
    `${labels[entry.status].padEnd(5)} ${entry.id.padEnd(21)} ${entry.message}`;
  const lines = ["Service:"];
  lines.push(...result.shared.checks.map(line));
  for (const show of result.shows) {
    lines.push(`Show ${show.show_id}:`);
    lines.push(...show.checks.map(line));
  }
  lines.push(`Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail, ${result.summary.not_checked} not checked`);
  return lines.join("\n");
}
