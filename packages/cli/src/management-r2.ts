import { m6ServiceConfigHash, parseServiceConfig, serviceAdmissionSchema, serviceConfigSchema } from "@castloop/shared";
import type { ServiceAdmission, ServiceConfig } from "@castloop/shared";
import type { StagingRestOptions } from "./staging-rest";

export type ManagementObject = { source: string; etag: string };
export type ManagementReader = { read: (key: string, maximum?: number) => Promise<ManagementObject | null> };

export class ManagementR2Reader implements ManagementReader {
  private readonly config: ServiceConfig;
  constructor(config: ServiceConfig, private readonly options: StagingRestOptions = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  }) {
    this.config = serviceConfigSchema.parse(config);
    if (options.accountId !== this.config.account_id || !options.apiToken || /[\r\n]/.test(options.apiToken)) {
      throw new Error("Private R2 credentials do not match the service account");
    }
  }
  async read(key: string, maximum = 16384): Promise<ManagementObject | null> {
    if (!/^(system|public\/episodes)\//.test(key) || key.split("/").some((part) => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) throw new Error("Invalid bounded management record read");
    const config = this.config;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}/r2/buckets/${encodeURIComponent(config.bucket_name)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
    const response = await (this.options.transport ?? fetch)(url, { method: "GET", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${this.options.apiToken}`, "Accept-Encoding": "identity" } });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status !== 200 || !response.body || response.headers.has("content-range") || !response.headers.get("ETag")) {
      await response.body?.cancel(); throw new Error("Private R2 management record was not verified");
    }
    const reader = response.body.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maximum) throw new Error("Private R2 management record exceeds its size limit");
        chunks.push(chunk.value);
      }
      if (!size) throw new Error("Private R2 management record is empty");
      return { source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)), etag: response.headers.get("ETag")! };
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}

export async function readManagementRuntime(reader: ManagementReader, config: ServiceConfig): Promise<{
  admission: ServiceAdmission; workerVersionId: string; admissionWindowId: string;
}> {
  const before = await reader.read("system/service.toml");
  const object = await reader.read("system/lifecycle-service.json");
  if (!before || !object || await m6ServiceConfigHash(parseServiceConfig(before.source)) !== await m6ServiceConfigHash(config)) {
    throw new Error("Management snapshot has another service configuration");
  }
  const admission = serviceAdmissionSchema.parse(JSON.parse(object.source));
  const readiness = admission.runtime_readiness;
  if (admission.service_id !== config.service_id || admission.mode !== "m6" || !["open", "paused"].includes(admission.state) ||
    admission.url_change || !readiness || readiness.management_protocol !== "queue-management-v1" ||
    readiness.service_config_sha256 !== await m6ServiceConfigHash(config) || !admission.last_resumed_pause_id) {
    throw new Error("Queue management requires verified queue-management-v1 readiness and an explicit resume; update the Worker first");
  }
  const after = await reader.read("system/service.toml");
  if (before.etag !== after?.etag || before.source !== after.source) throw new Error("Service configuration changed during management inspection");
  return { admission, workerVersionId: readiness.worker_version_id, admissionWindowId: admission.last_resumed_pause_id };
}
