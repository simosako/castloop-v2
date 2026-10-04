import { m6RuntimeTargetSchema, serviceConfigSchema, serviceManagementBaseUrl } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";

export type M6AdminTransport = (input: URL, init: RequestInit) => Promise<Response>;
const RESPONSE_BUDGET = 65536;
const ROUTE_LABELS = { staging: "Staging", publication: "Publication", lifecycle: "Lifecycle", shows: "Show registration", target: "Target inspection", catalog: "Catalog listing", service: "Service administration",
  domain: "Domain administration", "setup/prepare": "Setup preparation", "setup/status": "Setup status", "setup/complete": "Setup completion", "update/begin": "Compatible update admission" };

export class M6AdminOperationRejected extends Error {}

export async function readM6JsonResponse(response: Response, maximumBytes = RESPONSE_BUDGET): Promise<unknown> {
  const length = response.headers.get("Content-Length");
  if (response.headers.get("Cache-Control") !== "no-store" ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "") ||
    length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximumBytes)) {
    if (response.body) await response.body.cancel();
    throw new Error("Invalid management response headers");
  }
  if (!response.body) throw new Error("Missing management response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error("Management response exceeds its record budget");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    await reader.cancel();
    throw new Error("Invalid management response body");
  } finally { reader.releaseLock(); }
}

export class M6AdminJsonClient {
  readonly config: ServiceConfig;
  readonly managementBaseUrl: string;
  private readonly adminKey: string;
  private readonly transport: M6AdminTransport;

  constructor(config: ServiceConfig, adminKey: string, transport: M6AdminTransport = fetch) {
    this.config = serviceConfigSchema.parse(config);
    this.managementBaseUrl = serviceManagementBaseUrl(this.config);
    if (!adminKey || /[\u0000-\u001f\u007f]/.test(adminKey)) throw new Error("M6 administration requires a valid local administrator key");
    this.adminKey = adminKey;
    this.transport = transport;
  }

  async post(route: keyof typeof ROUTE_LABELS, input: object): Promise<unknown> {
    if (!Object.hasOwn(ROUTE_LABELS, route)) throw new Error("Unknown M6 administration route");
    const label = ROUTE_LABELS[route];
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 16384) throw new Error(`${label} request exceeds its record budget`);
    return this.send(new URL(`/admin/${route}`, this.managementBaseUrl), label, body, route === "target" ? 2_000_000 : RESPONSE_BUDGET);
  }

  async getSetupProbe(operationId: string): Promise<unknown> {
    m6RuntimeTargetSchema.shape.operation_id.parse(operationId);
    const url = new URL("/admin/setup/probe", this.managementBaseUrl);
    url.searchParams.set("operation_id", operationId);
    return this.send(url, "Setup probe");
  }

  async getRuntimeHealth(): Promise<unknown> {
    return this.send(new URL("/admin/health", this.managementBaseUrl), "Runtime health");
  }

  private async send(url: URL, label: string, body?: string, maximumBytes = RESPONSE_BUDGET): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(url, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120000), cache: "no-store",
        headers: { "X-Castloop-Key": this.adminKey, "User-Agent": "castloop-cli/0.1", "Content-Type": "application/json" }, body,
      });
    } catch {
      throw new Error(`${label} request outcome is unknown; inspect retained ownership/progress without automatic retry`);
    }
    try {
      if (response.status !== 200) {
        if (label === ROUTE_LABELS.domain && response.status === 409) {
          const value = await readM6JsonResponse(response);
          if (value && typeof value === "object" && "reason_code" in value && value.reason_code === "domain_operation_blocked") {
            throw new M6AdminOperationRejected("Domain operation was rejected after its server invocation returned; inspect retained ownership before retrying");
          }
        }
        if (response.body) await response.body.cancel();
        throw new Error("Management operation was not confirmed");
      }
      return await readM6JsonResponse(response, maximumBytes);
    } catch (error) {
      if (error instanceof M6AdminOperationRejected) throw error;
      throw new Error(`${label} response was not verified; inspect retained ownership/progress without automatic retry`);
    }
  }
}
