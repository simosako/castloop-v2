import { z } from "zod";
import { requireSqliteDomainConnection, sqliteDomainConnectionSchema, sqliteDomainHostnameSchema, sqliteDomainIdSchema } from "../../shared/src/sqlite-domain";
import type { SqliteDomainConnection, SqliteDomainRequest } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { collectStreamBytes } from "./bounded-http-read";
import { AgentError } from "./agent-output";
import { requireR2RestOptions } from "./verified-r2-put";
import type { R2RestOptions } from "./verified-r2-put";

const id = z.string().regex(/^[a-f0-9]{32}$/);
const rawDomain = z.object({ id: sqliteDomainIdSchema, hostname: z.string().max(253), service: z.string(), zone_id: id, zone_name: z.string(),
  cert_id: z.string(), environment: z.string(), enabled: z.boolean(), previews_enabled: z.boolean() });
const pagination = z.object({ page: z.number().int().positive(), per_page: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(), total_count: z.number().int().nonnegative(), total_pages: z.number().int().nonnegative().optional() });
const dnsPagination = pagination.extend({ per_page: z.number().int().positive(), total_pages: z.number().int().nonnegative() });
const envelope = z.object({ success: z.literal(true), errors: z.array(z.unknown()).max(0).nullable(), result: z.unknown().optional(),
  result_info: pagination.optional() });
type Envelope = z.infer<typeof envelope>;
type DomainApiOperation = "domain_list" | "domain_attach" | "domain_get" | "domain_detach" | "zone_get" | "dns_list" | "route_list";
type DomainMethod = "GET" | "PUT" | "DELETE";
type DomainFailureCode = "transport_unverified" | "http_status_unverified" | "body_missing" | "partial_response_unverified" | "body_unverified" | "json_unverified" |
  "envelope_unverified" | "connection_schema_unverified" | "connection_target_mismatch" | "connection_receipt_mismatch";
type ResponseKind = "missing" | "null" | "array" | "object" | "string" | "number" | "boolean" | "other";
type EnvironmentKind = "invalid_result" | "missing" | "null" | "empty_string" | "production" | "other_string" | "non_string";
type ValidationField = { path: string[]; code: string };
type DomainDiagnosticDetails = { http_status?: number; response_kind?: ResponseKind; environment_kind?: EnvironmentKind;
  expected_environment?: "production"; fields?: ValidationField[] };
const connectionFields = new Set(["id", "cert_id", "hostname", "zone_id", "zone_name", "service", "environment", "enabled", "previews_enabled"]);
const validationCodes = new Set(["invalid_type", "invalid_format", "invalid_value", "unrecognized_keys", "too_small", "too_big", "custom"]);

function responseKind(input: unknown): ResponseKind {
  if (input === undefined) return "missing";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  const kind = typeof input;
  return kind === "object" || kind === "string" || kind === "number" || kind === "boolean" ? kind : "other";
}

function environmentKind(input: unknown): EnvironmentKind {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid_result";
  if (!Object.hasOwn(input, "environment")) return "missing";
  const value = (input as { environment: unknown }).environment;
  if (value === null) return "null";
  if (value === "") return "empty_string";
  if (value === "production") return "production";
  return typeof value === "string" ? "other_string" : "non_string";
}

function logDomainFailure(apiOperation: DomainApiOperation, method: DomainMethod, reason: DomainFailureCode, details: DomainDiagnosticDetails = {}): void {
  console.error(JSON.stringify({ event: "sqlite_domain_cloudflare", api_operation: apiOperation, method,
    reason_code: reason, ...details, will_retry: false }));
}

function verifiedConnection(input: unknown, request: SqliteDomainRequest, operation: "domain_attach" | "domain_get"): SqliteDomainConnection {
  try { return requireSqliteDomainConnection(input, request); }
  catch (error) {
    const fields = error instanceof z.ZodError ? error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.length === 1 && typeof issue.path[0] === "string" && connectionFields.has(issue.path[0]) ? [issue.path[0]] : [],
      code: validationCodes.has(issue.code) ? issue.code : "validation_failed",
    })) : undefined;
    logDomainFailure(operation, operation === "domain_attach" ? "PUT" : "GET",
      error instanceof z.ZodError ? "connection_schema_unverified" : "connection_target_mismatch",
      { http_status: 200, response_kind: responseKind(input), environment_kind: environmentKind(input), expected_environment: "production", ...(fields ? { fields } : {}) });
    throw new AgentError("domain_connection_unverified", "Cloudflare domain connection receipt was not verified; preserve its journal without replay or adoption.", fields);
  }
}

function hostnameCovered(pattern: string, hostname: string): boolean {
  const host = pattern.toLowerCase().replace(/^(https?:\/\/|\*:\/\/)/, "").split("/")[0];
  if (!host || !/^[a-z0-9.*-]+$/.test(host)) throw new Error("Cannot verify the configured Worker route pattern");
  return new RegExp(`^${host.split("*").map((part) => part.replace(/\./g, "\\.")).join(".*")}$`).test(hostname);
}

export class SqliteDomainCloudflare {
  readonly config: SqliteServiceConfig;
  private readonly account: string;
  constructor(config: SqliteServiceConfig, private readonly options: R2RestOptions) {
    this.config = sqliteServiceConfigSchema.parse(config); requireR2RestOptions(this.config.account_id, options);
    this.account = `/accounts/${this.config.account_id}`;
  }
  private async call(operation: DomainApiOperation, method: DomainMethod, path: string, body?: object): Promise<Envelope> {
    let response: Response;
    try {
      response = await (this.options.transport ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, { method,
        redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${this.options.apiToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      logDomainFailure(operation, method, "transport_unverified");
      throw new Error("Cloudflare domain request outcome is unknown; preserve its journal without replay");
    }
    if (response.status !== 200 || !response.body || response.headers.has("Content-Range")) {
      logDomainFailure(operation, method, response.status !== 200 ? "http_status_unverified" : !response.body ? "body_missing" : "partial_response_unverified",
        { http_status: response.status });
      await response.body?.cancel(); throw new Error(`Cloudflare domain response was not verified (HTTP ${response.status})`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await collectStreamBytes(response.body, 1_000_000, true));
    } catch {
      logDomainFailure(operation, method, "body_unverified", { http_status: response.status });
      throw new Error("Cloudflare domain response was not verified; never replay an uncertain mutation");
    }
    let input: unknown;
    try { input = JSON.parse(text); }
    catch {
      logDomainFailure(operation, method, "json_unverified", { http_status: response.status });
      throw new Error("Cloudflare domain response was not verified; never replay an uncertain mutation");
    }
    const parsed = envelope.safeParse(input);
    if (!parsed.success) {
      logDomainFailure(operation, method, "envelope_unverified", { http_status: response.status, response_kind: responseKind(input) });
      throw new Error("Cloudflare domain response was not verified; never replay an uncertain mutation");
    }
    return parsed.data;
  }
  async list() {
    const response = await this.call("domain_list", "GET", `${this.account}/workers/domains`);
    const domains = z.array(rawDomain).max(10000).parse(response.result);
    if (response.result_info && (response.result_info.page !== 1 || (response.result_info.total_pages ?? 1) > 1 ||
      response.result_info.total_count !== domains.length || response.result_info.count !== domains.length)) throw new Error("Domain listing is incomplete");
    return domains;
  }
  async verifyKnown(connection: SqliteDomainConnection | null): Promise<void> {
    const current = (await this.list()).filter((domain) => domain.service === this.config.worker_name);
    if (!connection) {
      if (current.length || this.config.public_base_url !== this.config.workers_dev_base_url) throw new Error("Unknown Worker domains cannot be adopted during deployment");
      return;
    }
    if (current.length !== 1 || this.config.public_base_url !== `https://${connection.hostname}` ||
      JSON.stringify(sqliteDomainConnectionSchema.parse(current[0])) !== JSON.stringify(connection)) throw new Error("Known Worker domain connection differs during deployment");
  }
  private async zone(zoneId: string) {
    id.parse(zoneId);
    const zone = z.object({ id, name: sqliteDomainHostnameSchema, status: z.literal("active"), type: z.literal("full"),
      account: z.object({ id }) }).parse((await this.call("zone_get", "GET", `/zones/${zoneId}`)).result);
    if (zone.id !== zoneId || zone.account.id !== this.config.account_id) throw new Error("Domain zone belongs to another account");
    return zone;
  }
  private async pages(path: string): Promise<unknown[]> {
    const values: unknown[] = []; let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const response = await this.call("dns_list", "GET", `${path}?page=${page}&per_page=100`);
      const items = z.array(z.unknown()).max(100).parse(response.result), info = dnsPagination.parse(response.result_info);
      if (!info || info.page !== page || info.per_page !== 100 || info.count !== items.length || info.total_pages > 100 ||
        total !== undefined && total !== info.total_count) throw new Error("Zone listing pagination was not verified");
      total = info.total_count; values.push(...items);
      if (page >= info.total_pages) {
        if (values.length !== total) throw new Error("Zone listing is incomplete");
        return values;
      }
      if (!items.length) throw new Error("Zone listing ended before its declared final page");
    }
    throw new Error("Zone listing exceeds its finite page budget");
  }
  async preflightAdd(inputHostname: string, zoneId: string) {
    const hostname = sqliteDomainHostnameSchema.parse(inputHostname), zone = await this.zone(zoneId);
    if (!hostname.endsWith(`.${zone.name}`)) throw new Error("A dedicated subdomain of this exact zone is required");
    const domains = await this.list();
    if (domains.some((domain) => domain.service === this.config.worker_name || domain.hostname.toLowerCase() === hostname)) throw new Error("Existing Worker or hostname domain connections cannot be adopted");
    const dns = z.array(z.object({ name: z.string(), type: z.string() })).parse(await this.pages(`/zones/${zoneId}/dns_records`));
    for (const record of dns) {
      const name = record.name.toLowerCase();
      if (name === hostname || name.startsWith("*.") && hostname.endsWith(name.slice(1)) ||
        record.type.toUpperCase() === "NS" && name !== zone.name && hostname.endsWith(`.${name}`)) throw new Error("Existing DNS or delegation conflicts with this hostname");
    }
    const response = await this.call("route_list", "GET", `/zones/${zoneId}/workers/routes`);
    const routes = z.array(z.object({ pattern: z.string() })).max(10000).parse(response.result);
    if (response.result_info && (response.result_info.page !== 1 || (response.result_info.total_pages ?? 1) > 1 ||
      response.result_info.total_count !== routes.length || response.result_info.count !== routes.length)) throw new Error("Worker route listing is incomplete");
    if (routes.some((route) => hostnameCovered(route.pattern, hostname))) throw new Error("An existing Worker route covers this hostname");
    return { hostname, zone_id: zone.id, zone_name: zone.name };
  }
  async attach(request: SqliteDomainRequest): Promise<SqliteDomainConnection> {
    if (request.action !== "add") throw new Error("Only an add request can attach a domain");
    const target = await this.preflightAdd(request.hostname, request.zone_id);
    if (target.zone_name !== request.zone_name) throw new Error("Frozen domain zone name differs");
    return verifiedConnection((await this.call("domain_attach", "PUT", `${this.account}/workers/domains`, {
      hostname: target.hostname, zone_id: target.zone_id, service: this.config.worker_name, enabled: true, previews_enabled: false,
    })).result, request, "domain_attach");
  }
  async inspect(request: SqliteDomainRequest, connection: SqliteDomainConnection): Promise<void> {
    requireSqliteDomainConnection(connection, request);
    const zone = await this.zone(request.zone_id);
    if (zone.name !== request.zone_name) throw new Error("Frozen domain zone differs");
    const current = verifiedConnection((await this.call("domain_get", "GET", `${this.account}/workers/domains/${encodeURIComponent(connection.id)}`)).result, request, "domain_get");
    if (JSON.stringify(current) !== JSON.stringify(connection)) {
      logDomainFailure("domain_get", "GET", "connection_receipt_mismatch", { http_status: 200 });
      throw new Error("Domain connection receipt changed");
    }
    const domains = (await this.list()).filter((domain) => domain.service === this.config.worker_name);
    if (domains.length !== 1 || JSON.stringify(requireSqliteDomainConnection(domains[0], request)) !== JSON.stringify(connection)) throw new Error("Worker domain membership changed");
  }
  async detach(request: SqliteDomainRequest, connection: SqliteDomainConnection): Promise<void> {
    if (request.action !== "remove") throw new Error("Only a remove request can detach a domain");
    await this.inspect(request, connection);
    const result = await this.call("domain_detach", "DELETE", `${this.account}/workers/domains/${encodeURIComponent(connection.id)}`);
    if (result.result !== undefined && result.result !== null) throw new Error("Domain DELETE success response differs");
  }
  async verifyTls(origin: string): Promise<void> {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.port) throw new Error("Expected an exact HTTPS origin for TLS verification");
    let response: Response;
    try { response = await (this.options.transport ?? fetch)(`${origin}/`, { method: "HEAD", redirect: "error",
      signal: AbortSignal.timeout(10000), cache: "no-store" }); }
    catch { throw new Error("Domain DNS/TLS is not ready; continue observation explicitly without reconnecting"); }
    await response.body?.cancel();
    if (response.status !== 404) throw new Error("Domain TLS reachability response differs; no redirects are followed");
  }
}
