import { z } from "zod";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { collectStreamBytes, requireR2RestOptions } from "./bounded-http-read";
import type { R2RestOptions } from "./bounded-http-read";
import { LOGPUSH_FIELDS, LOGPUSH_RETENTION_DAYS, logpushFilter, logpushJobName, logpushPrefix,
  logpushTokenName, logpushZoneIdSchema } from "./logpush-config";
import type { LogpushConfiguration, LogpushZone } from "./logpush-config";
import { sha256HexSync } from "./sha256";
import { decodeUtf8Strict } from "./utf8";

const id = logpushZoneIdSchema;
const envelope = z.object({ success: z.literal(true), result: z.unknown(), result_info: z.unknown().optional() });
const instant = z.iso.datetime({ offset: true }).transform(Date.parse).nullable();
const jobSchema = z.object({ id: z.number().int().positive(), name: z.string(), dataset: z.string(), enabled: z.boolean(),
  destination_conf: z.string(), filter: z.string().nullable(), output_options: z.object({
    field_names: z.array(z.string()), sample_rate: z.number(), timestamp_format: z.string(),
  }), last_complete: instant, last_error: instant, error_message: z.string().nullable() });
export type LogpushJob = z.infer<typeof jobSchema>;
const tokenSchema = z.object({ id, name: z.string(), status: z.string(), policies: z.array(z.object({
  effect: z.string(), permission_groups: z.array(z.object({ id })), resources: z.record(z.string(), z.unknown()),
})) });
type Token = z.infer<typeof tokenSchema>;
const ruleSchema = z.object({ id: z.string(), enabled: z.boolean(), conditions: z.object({ prefix: z.string() }),
  deleteObjectsTransition: z.unknown().optional(), storageClassTransitions: z.unknown().optional() }).passthrough();
type Rule = z.infer<typeof ruleSchema>;

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Logpush API response schema was not verified");
  return result.data;
}
function sameJson(a: unknown, b: unknown): boolean {
  const sorted = (_key: string, value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value) ?
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value;
  return JSON.stringify(a, sorted) === JSON.stringify(b, sorted);
}

export class LogpushCloudflare {
  private readonly account: string;
  constructor(private readonly config: SqliteServiceConfig, private readonly options: R2RestOptions) {
    requireR2RestOptions(config.account_id, options);
    this.account = `/accounts/${encodeURIComponent(config.account_id)}`;
  }
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object, missing = false) {
    let response: Response;
    try {
      response = await (this.options.transport ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
        headers: { Authorization: `Bearer ${this.options.apiToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error("Logpush API outcome is unknown; inspect current state before rerunning the same command"); }
    try {
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      if (![200, 201].includes(response.status) || !response.body || response.headers.has("Content-Range")) {
        await response.body?.cancel(); throw new Error();
      }
      const bytes = await collectStreamBytes(response.body, 1_000_000, true);
      return checked(envelope, JSON.parse(decodeUtf8Strict(bytes)));
    } catch {
      throw new Error(`Logpush API response was not verified (HTTP ${response.status}); no mutation is automatically retried`);
    }
  }
  private bucketPath(bucket: string): string { return `${this.account}/r2/buckets/${encodeURIComponent(bucket)}`; }
  private jobsPath(zone: LogpushZone): string { return `/zones/${zone.zone_id}/logpush/jobs`; }
  async preflight(zoneId: string, hosts: readonly string[]): Promise<void> {
    const zone = checked(z.object({ id, name: z.string(), status: z.literal("active"), type: z.literal("full"),
      account: z.object({ id }) }), (await this.call("GET", `/zones/${zoneId}`))!.result);
    if (zone.id !== zoneId || zone.account.id !== this.config.account_id || hosts.some((host) => !host.endsWith(`.${zone.name}`))) {
      throw new Error("Logpush hosts must belong to this account's configured active/full zone");
    }
    const fields = checked(z.record(z.string(), z.unknown()),
      (await this.call("GET", `/zones/${zoneId}/logpush/datasets/http_requests/fields`))!.result);
    if (LOGPUSH_FIELDS.some((field) => !Object.hasOwn(fields, field))) throw new Error("Required HTTP Requests Logpush fields are unavailable");
  }
  async bucket(bucket: string) {
    const value = await this.call("GET", this.bucketPath(bucket), undefined, true);
    if (!value) return null;
    const result = checked(z.object({ name: z.string(), storage_class: z.literal("Standard"), jurisdiction: z.literal("default") }), value.result);
    if (result.name !== bucket) throw new Error("Logpush bucket identity differs");
    return result;
  }
  async createBucket(bucket: string): Promise<void> {
    const value = checked(z.object({ name: z.string() }), (await this.call("POST", `${this.account}/r2/buckets`, {
      name: bucket, storageClass: "Standard",
    }))!.result);
    if (value.name !== bucket) throw new Error("Created Logpush bucket identity differs");
  }
  private retentionRule(config: LogpushConfiguration) {
    return { id: `castloop-access-${config.service_id}`, enabled: true, conditions: { prefix: `http/${config.service_id}/` },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: LOGPUSH_RETENTION_DAYS * 86400 } } };
  }
  async inspectBucket(config: LogpushConfiguration) {
    const path = this.bucketPath(config.bucket_name);
    const managed = checked(z.object({ enabled: z.boolean() }), (await this.call("GET", `${path}/domains/managed`))!.result);
    const custom = checked(z.object({ domains: z.array(z.unknown()) }), (await this.call("GET", `${path}/domains/custom`))!.result);
    const { rules } = checked(z.object({ rules: z.array(ruleSchema) }), (await this.call("GET", `${path}/lifecycle`))!.result);
    const desired = this.retentionRule(config), other = rules.filter((rule) => rule.id !== desired.id);
    const conflict = other.some((rule) => rule.enabled && (rule.deleteObjectsTransition || rule.storageClassTransitions) &&
      (desired.conditions.prefix.startsWith(rule.conditions.prefix) || rule.conditions.prefix.startsWith(desired.conditions.prefix)));
    return { private: !managed.enabled && custom.domains.length === 0,
      retention_valid: !conflict && rules.filter((rule) => rule.id === desired.id).length === 1 &&
        sameJson(rules.find((rule) => rule.id === desired.id), desired), conflict, rules };
  }
  async retain(config: LogpushConfiguration, rules: Rule[]): Promise<void> {
    const desired = this.retentionRule(config);
    await this.call("PUT", `${this.bucketPath(config.bucket_name)}/lifecycle`, {
      rules: [...rules.filter((rule) => rule.id !== desired.id), desired],
    });
  }
  async permission(): Promise<string> {
    const groups = checked(z.array(z.object({ id, name: z.string() })),
      (await this.call("GET", `${this.account}/tokens/permission_groups`))!.result);
    const matches = groups.filter((group) => group.name === "Workers R2 Storage Bucket Item Write");
    if (matches.length !== 1) throw new Error("Bucket-scoped R2 Object Read and Write permission is unavailable");
    return matches[0]!.id;
  }
  async tokens(): Promise<Token[]> {
    const tokens: Token[] = []; let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const response = (await this.call("GET", `${this.account}/tokens?page=${page}&per_page=50&include_expired=true`))!;
      const items = checked(z.array(tokenSchema).max(50), response.result);
      const info = checked(z.object({ page: z.number().int(), per_page: z.number().int(), count: z.number().int(),
        total_count: z.number().int().min(0).max(5000) }), response.result_info);
      if (info.page !== page || info.per_page !== 50 || info.count !== items.length ||
        total !== undefined && total !== info.total_count) throw new Error("Logpush token inventory changed or is incomplete");
      total = info.total_count; tokens.push(...items);
      if (tokens.length === total) return tokens;
      if (!items.length || tokens.length > total) break;
    }
    throw new Error("Logpush token inventory exceeds its page budget or is incomplete");
  }
  private policies(config: LogpushConfiguration, permission: string) {
    return [{ effect: "allow", permission_groups: [{ id: permission }],
      resources: { [`com.cloudflare.edge.r2.bucket.${config.account_id}_default_${config.bucket_name}`]: "*" } }];
  }
  verifyToken(token: Token, config: LogpushConfiguration, zone: LogpushZone, permission: string): void {
    const policies = token.policies.map(({ effect, permission_groups, resources }) => ({ effect, permission_groups, resources }));
    if (token.name !== logpushTokenName(zone) || token.status !== "active" ||
      !sameJson(policies, this.policies(config, permission)) || zone.token_id !== null && zone.token_id !== token.id) {
      throw new Error("Logpush destination token differs from its saved bucket-scoped identity");
    }
  }
  async createToken(config: LogpushConfiguration, zone: LogpushZone, permission: string) {
    const value = checked(tokenSchema.extend({ value: z.string().min(1) }), (await this.call("POST", `${this.account}/tokens`, {
      name: logpushTokenName(zone), policies: this.policies(config, permission),
    }))!.result);
    this.verifyToken(value, config, { ...zone, token_id: null }, permission);
    return { id: value.id, secret: sha256HexSync(value.value) };
  }
  async deleteToken(tokenId: string): Promise<void> {
    const value = checked(z.object({ id }), (await this.call("DELETE", `${this.account}/tokens/${tokenId}`))!.result);
    if (value.id !== tokenId) throw new Error("Revoked Logpush token identity differs");
  }
  async jobs(zone: LogpushZone): Promise<LogpushJob[]> {
    const response = (await this.call("GET", this.jobsPath(zone)))!;
    if (response.result_info !== undefined) {
      const info = checked(z.object({ page: z.literal(1), total_pages: z.number().int().max(1) }), response.result_info);
      if (info.page !== 1) throw new Error("Logpush job inventory is incomplete");
    }
    const jobs = checked(z.array(z.object({ id: z.number().int().positive(), name: z.string() }).passthrough()), response.result);
    return jobs.filter((job) => job.name === logpushJobName(zone)).map((job) => checked(jobSchema, job));
  }
  private destination(config: LogpushConfiguration, zone: LogpushZone, tokenId: string, secret: string): string {
    return `r2://${config.bucket_name}/${logpushPrefix(config, zone.zone_id)}{DATE}/?` +
      new URLSearchParams({ "account-id": config.account_id, "access-key-id": tokenId, "secret-access-key": secret }).toString();
  }
  verifyJob(job: LogpushJob, config: LogpushConfiguration, zone: LogpushZone, tokenId: string): boolean {
    let destination: URL, filter: unknown;
    try { destination = new URL(job.destination_conf); filter = JSON.parse(job.filter ?? "null"); }
    catch { throw new Error("Logpush job destination or filter was not verified"); }
    const fields = job.output_options.field_names;
    if (job.name !== logpushJobName(zone) || job.dataset !== "http_requests" ||
      zone.job_id !== null && zone.job_id !== job.id || destination.protocol !== "r2:" || destination.username || destination.password ||
      destination.host !== config.bucket_name || destination.pathname !== `/${logpushPrefix(config, zone.zone_id)}%7BDATE%7D/` || destination.hash ||
      destination.searchParams.get("account-id") !== config.account_id || destination.searchParams.get("access-key-id") !== tokenId ||
      !destination.searchParams.get("secret-access-key") || [...destination.searchParams.keys()].sort().join(",") !== "access-key-id,account-id,secret-access-key" ||
      fields.length !== LOGPUSH_FIELDS.length || LOGPUSH_FIELDS.some((field) => !fields.includes(field)) ||
      job.output_options.sample_rate !== 1 || job.output_options.timestamp_format !== "rfc3339") {
      throw new Error("Logpush job differs from its saved private destination or privacy-safe fields");
    }
    const matches = (settings: LogpushZone["settings"]) => sameJson(filter, JSON.parse(logpushFilter(settings.hosts)));
    if (!matches(zone.settings) && (!zone.previous_settings || !matches(zone.previous_settings))) {
      throw new Error("Logpush job filter differs from its saved current and previous settings");
    }
    return matches(zone.settings) && job.enabled === zone.settings.enabled;
  }
  async createJob(config: LogpushConfiguration, zone: LogpushZone, token: { id: string; secret: string }): Promise<LogpushJob> {
    return checked(jobSchema, (await this.call("POST", this.jobsPath(zone), { name: logpushJobName(zone),
      dataset: "http_requests", enabled: zone.settings.enabled, filter: logpushFilter(zone.settings.hosts),
      output_options: { field_names: LOGPUSH_FIELDS, sample_rate: 1, timestamp_format: "rfc3339" },
      destination_conf: this.destination(config, zone, token.id, token.secret),
    }))!.result);
  }
  async updateJob(zone: LogpushZone, job: LogpushJob): Promise<void> {
    await this.call("PUT", `${this.jobsPath(zone)}/${job.id}`, { enabled: zone.settings.enabled, filter: logpushFilter(zone.settings.hosts) });
  }
}
