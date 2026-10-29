import { version } from "../../../package.json";
import { loadWorkspaceConfig } from "./workspace-config";
import { administratorKey } from "./administrator-key";
import type { DiagnosticCheck, SqliteServiceConfig } from "@castloop/shared";
import { pendingLocalDomainChanges } from "./sqlite-domain-local";
import { loadAdminConfig } from "./admin-config";

type Check = DiagnosticCheck;
export type DoctorResult = { cli_version: string; checks: Check[]; summary: Record<Check["status"], number> };

export async function diagnoseLocal(root: string,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<DoctorResult> {
  const checks: Check[] = [{ id: "cli", scope: "local", status: "pass", code: "supported_formats", message: "Service schema 2, show-v1, sqlite-sequential-v1", next_actions: [] }];
  let config: SqliteServiceConfig | undefined;
  try {
    config = await loadWorkspaceConfig(root);
    checks.push({ id: "workspace", scope: "local", status: "pass", code: "valid_config", message: "Service configuration is valid", next_actions: [] });
  } catch {
    checks.push({ id: "workspace", scope: "local", status: "fail", code: "invalid_config", message: "Service configuration is missing, unreadable or invalid", next_actions: ["inspect_local_configuration"] });
  }
  try {
    const admin = await loadAdminConfig(root);
    checks.push({ id: "admin-config", scope: "local", status: "pass", code: admin.timezone ? "admin_timezone_configured" : "server_timezone_default",
      message: admin.timezone ? "Administrator timezone is valid; service identity is unchanged" : "No administrator timezone preference; server basis is UTC", next_actions: [] });
  } catch {
    checks.push({ id: "admin-config", scope: "local", status: "fail", code: "invalid_admin_config",
      message: "Optional castloop-admin.toml is unreadable or invalid; no fallback to another timezone", next_actions: ["inspect_local_admin_configuration"] });
  }
  try {
    administratorKey(root);
    checks.push({ id: "local-state", scope: "local", status: "pass", code: "key_present", message: "Administrator key is readable; remote validity not checked", next_actions: [] });
  } catch {
    checks.push({ id: "local-state", scope: "local", status: "warn", code: "key_unavailable", message: "Administrator key is missing, unreadable or invalid; do not regenerate retained keys", next_actions: ["inspect_or_restore_original_backup"] });
  }
  const credentials = !!environment.CLOUDFLARE_ACCOUNT_ID && !!environment.CLOUDFLARE_API_TOKEN;
  checks.push({ id: "credentials", scope: "local", status: credentials ? "pass" : "warn", code: credentials ? "credentials_present" : "credentials_missing",
    message: credentials ? "Cloudflare credentials are set; validity and permissions not checked" : "Cloudflare credentials are incomplete; offline work remains available", next_actions: credentials ? [] : ["configure_environment_without_sharing_secrets"] });
  const accountMismatch = !!config && !!environment.CLOUDFLARE_ACCOUNT_ID && environment.CLOUDFLARE_ACCOUNT_ID !== config.account_id;
  checks.push({ id: "account-target", scope: "local", status: accountMismatch ? "fail" : config && environment.CLOUDFLARE_ACCOUNT_ID ? "pass" : "not_checked",
    code: accountMismatch ? "account_mismatch" : config && environment.CLOUDFLARE_ACCOUNT_ID ? "account_matches" : "account_not_checked",
    message: accountMismatch ? "Environment account differs from the workspace; do not change resources" : "Account target comparison only; remote ownership not checked",
    next_actions: accountMismatch ? ["confirm_workspace_and_environment"] : [] });
  checks.push({ id: "remote", scope: "local", status: "not_checked", code: "local_only", message: "Remote readiness, operations and publication were not checked", next_actions: [] });
  if (config) {
    try {
      const pending = pendingLocalDomainChanges(root, config).length > 0;
      checks.push({ id: "domain-records", scope: "local", status: pending ? "warn" : "pass", code: pending ? "domain_operation_pending" : "domain_records_checked",
        message: pending ? "Unfinished domain records exist; inspect the same operation" : "Local domain records inspected; remote state not checked",
        next_actions: pending ? ["inspect_domain_operation_status"] : [] });
    } catch {
      checks.push({ id: "domain-records", scope: "local", status: "fail", code: "domain_records_unverified", message: "Local domain records could not be verified; preserve the records", next_actions: ["inspect_original_domain_records"] });
    }
  }
  const summary = { pass: 0, warn: 0, fail: 0, not_checked: 0 };
  for (const check of checks) summary[check.status]++;
  return { cli_version: version, checks, summary };
}

export function formatDoctor(result: DoctorResult): string {
  return result.checks.map((check) => `${({ pass: "PASS", warn: "WARN", fail: "FAIL", not_checked: "SKIP" })[check.status].padEnd(5)} ${check.id.padEnd(14)} ${check.message}`).join("\n") +
    `\nSummary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail, ${result.summary.not_checked} not checked`;
}
