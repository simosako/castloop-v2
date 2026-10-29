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
import { collectDeliveryChecks } from "./verify";
import type { R2RestOptions, R2RestTransport } from "./bounded-http-read";

export const DIAGNOSE_DEFAULT_MAX_SHOWS = 5;
export const DIAGNOSE_ABSOLUTE_MAX_SHOWS = 20;
const LOCAL_DOCTOR_CHECKS = new Set(["workspace", "local-state", "credentials", "account-target", "domain-records"]);
const diagnoseShowResultSchema = z.object({ show_id: z.string().max(32), checks: z.array(diagnosticCheckSchema).max(12), summary: diagnosticSummarySchema }).strict();
export const diagnoseResultSchema = z.object({ schema_version: z.literal(1),
  shared: z.object({ checks: z.array(diagnosticCheckSchema).max(12), summary: diagnosticSummarySchema }).strict(),
  shows: z.array(diagnoseShowResultSchema).max(DIAGNOSE_ABSOLUTE_MAX_SHOWS), summary: diagnosticSummarySchema }).strict();
export type DiagnoseResult = z.infer<typeof diagnoseResultSchema>;
export type DiagnoseShowResult = z.infer<typeof diagnoseShowResultSchema>;
type DiagnoseOptions = { maxShows?: number; external?: boolean; transport?: R2RestTransport; cloudflare?: R2RestOptions;
  environment?: Readonly<Record<string, string | undefined>> };

function check(id: string, scope: DiagnosticCheck["scope"], status: DiagnosticCheck["status"], code: string,
  message: string, next_actions: string[] = []): DiagnosticCheck { return { id, scope, status, code, message, next_actions }; }
function summarize(checks: DiagnosticCheck[]): DiagnosticSummary {
  const summary = { pass: 0, warn: 0, fail: 0, not_checked: 0 };
  for (const entry of checks) summary[entry.status] += 1;
  return summary;
}

async function cfCredentialsCheck(config: SqliteServiceConfig, options: DiagnoseOptions): Promise<DiagnosticCheck> {
  const accountId = options.cloudflare?.accountId, token = options.cloudflare?.apiToken;
  if (!accountId || !token) return check("cf-credentials", "remote", "not_checked", "cf_credentials_absent", "Cloudflare credentials are not set; token validity was not checked");
  let response: Response;
  try {
    response = await (options.cloudflare?.transport ?? options.transport ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`,
      { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch { return check("cf-credentials", "remote", "fail", "cf_unreachable", "The Cloudflare API was unreachable; token validity is unknown"); }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    return response.status === 403 ? check("cf-credentials", "remote", "warn", "cf_account_forbidden", "The configured account is not readable; inspect the token permission scopes") :
      check("cf-credentials", "remote", "fail", [400, 401].includes(response.status) ? "cf_token_invalid" : "cf_unverified", "The Cloudflare account response was not verifiable");
  }
  try {
    const bytes = await collectStreamBytes(response.body, 1_000_000);
    const value = z.object({ success: z.literal(true), result: z.object({ id: z.string() }) }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
    if (value.result.id !== config.account_id || value.result.id !== accountId) throw new Error("Cloudflare account differs");
    return check("cf-credentials", "remote", "pass", "cf_account_readable", "The API token can read the configured account; operation permissions are not proven");
  } catch { return check("cf-credentials", "remote", "fail", "cf_unverified", "The Cloudflare account response was not verifiable"); }
}

async function diagnoseShow(config: SqliteServiceConfig, showId: string, key: string | null, available: boolean, options: DiagnoseOptions): Promise<DiagnoseShowResult> {
  const checks: DiagnosticCheck[] = [];
  if (!key || !available) {
    for (const id of ["registration", "admission", "target-state"]) checks.push(check(id, "remote", key ? "fail" : "not_checked",
      key ? "observation_unavailable" : "administrator_key_unavailable", "Remote Show checks were not available"));
  } else {
    const client = new SqliteServiceClient(config, key, options.transport);
    let registered = false;
    try {
      const registration = await client.registration(showId); registered = registration.state === "registered";
      checks.push(check("registration", "remote", registered ? "pass" : "warn", registered ? "registered" : registration.state === "missing" ? "registration_missing" : "registration_pending",
        `Show registration is ${registration.state}`));
    } catch { checks.push(check("registration", "remote", "fail", "observation_unavailable", "The Show registration was not observable")); }
    if (registered) {
      try {
        const health = await client.health(showId);
        checks.push(health.publication_ready ? check("admission", "remote", "pass", "publication_ready", "The Show runtime is publication-ready") :
          check("admission", "remote", "warn", "not_publication_ready", "Show runtime readiness restricts publication"));
      } catch { checks.push(check("admission", "remote", "fail", "observation_unavailable", "Show health was not observable")); }
      try {
        const content = await client.content(showId);
        checks.push(check("target-state", "remote", content.show_lifecycle === "published" ? "pass" : content.show_lifecycle === "missing" ? "fail" : "warn",
          `target_${content.show_lifecycle}`, `The Show lifecycle is ${content.show_lifecycle}`));
      } catch { checks.push(check("target-state", "remote", "fail", "observation_unavailable", "Published Show content was not observable")); }
    } else for (const id of ["admission", "target-state"]) checks.push(check(id, "remote", "not_checked", "show_missing", "Show-dependent checks require a completed registration"));
  }
  return { show_id: showId, checks, summary: summarize(checks) };
}

export async function diagnoseShows(root: string, input: SqliteServiceConfig, showIds: string[], options: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const config = sqliteServiceConfigSchema.parse(input), maxShows = options.maxShows ?? DIAGNOSE_DEFAULT_MAX_SHOWS;
  if (!Number.isSafeInteger(maxShows) || maxShows < 1 || maxShows > DIAGNOSE_ABSOLUTE_MAX_SHOWS) throw new AgentError("invalid_arguments", `--max-shows must be an integer between 1 and ${DIAGNOSE_ABSOLUTE_MAX_SHOWS}`);
  const ids = showIds.map((id) => validateId(id, "show"));
  if (!ids.length) throw new AgentError("invalid_arguments", "diagnose requires at least one Show ID");
  if (new Set(ids).size !== ids.length) throw new AgentError("invalid_arguments", "diagnose requires distinct Show IDs");
  if (ids.length > maxShows) throw new AgentError("invalid_arguments", `diagnose accepts at most ${maxShows} Show IDs`);
  const doctor = await diagnoseLocal(root, options.environment ?? process.env);
  const shared = doctor.checks.filter((entry) => LOCAL_DOCTOR_CHECKS.has(entry.id));
  let key: string | null = null, health: SqliteHealth | null = null;
  try { key = administratorKey(root); } catch { key = null; }
  if (key) {
    try {
      health = sqliteHealthSchema.parse(await readSqliteManagementGet(new URL("/admin/sqlite-service/health", config.workers_dev_base_url), { "X-Castloop-Key": key }, { transport: options.transport }));
      if (health.service_id !== config.service_id || health.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
        health = null;
        shared.push(check("remote-identity", "remote", "fail", "runtime_differs", "The remote runtime differs from the local configuration; do not change resources", ["confirm_workspace_and_environment"]));
      } else shared.push(check("remote-identity", "remote", "pass", "runtime_matches", "The service runtime matches the local configuration"));
    } catch { shared.push(check("remote-identity", "remote", "fail", "observation_unavailable", "Service health was not observable", ["inspect_service_status"])); }
  } else shared.push(check("remote-identity", "remote", "not_checked", "administrator_key_unavailable", "The administrator key is unavailable; remote checks were skipped"));
  if (health) {
    shared.push(check("maintenance", "remote", health.publication_ready ? "pass" : "warn", health.publication_ready ? "no_maintenance" : "service_not_ready",
      health.publication_ready ? "No domain change or runtime restriction is in progress" : "The service is not publication-ready; an unfinished domain change may be pending"));
  } else shared.push(check("maintenance", "remote", key ? "fail" : "not_checked", key ? "observation_unavailable" : "administrator_key_unavailable", "Service readiness was not observable"));
  shared.push(await cfCredentialsCheck(config, options));
  const shows: DiagnoseShowResult[] = [];
  for (const showId of ids) shows.push(await diagnoseShow(config, showId, key, !!health, options));
  if (options.external) for (const show of shows) {
    try {
      const delivery = await collectDeliveryChecks(root, config, show.show_id, undefined, options.transport);
      const failed = delivery.checks.some((entry) => entry.status === "fail"), warned = delivery.checks.some((entry) => entry.status === "warn");
      show.checks.push(check("delivery", "external", failed ? "fail" : warned ? "warn" : "pass", failed ? "delivery_verification_failed" : warned ? "delivery_warn" : "delivery_verified", "External delivery checks completed", failed ? ["verify_show"] : []));
    } catch { show.checks.push(check("delivery", "external", "fail", "delivery_observation_unavailable", "External delivery checks could not be performed", ["verify_show"])); }
    show.summary = summarize(show.checks);
  }
  return diagnoseResultSchema.parse({ schema_version: 1, shared: { checks: shared, summary: summarize(shared) }, shows, summary: summarize([...shared, ...shows.flatMap((show) => show.checks)]) });
}

export function formatDiagnose(result: DiagnoseResult): string {
  const labels = { pass: "PASS", warn: "WARN", fail: "FAIL", not_checked: "SKIP" } as const;
  const line = (entry: DiagnosticCheck) => `${labels[entry.status].padEnd(5)} ${entry.id.padEnd(21)} ${entry.message}`;
  const lines = ["Service:", ...result.shared.checks.map(line)];
  for (const show of result.shows) lines.push(`Show ${show.show_id}:`, ...show.checks.map(line));
  lines.push(`Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail, ${result.summary.not_checked} not checked`);
  return lines.join("\n");
}
