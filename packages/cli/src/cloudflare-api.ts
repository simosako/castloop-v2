import type { ServiceConfig } from "@castloop/shared";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

type ApiResult<T> = { success: boolean; result: T; errors?: Array<{ code: number; message: string }> };
type QueueRecord = { queue_id: string; queue_name: string };
type ConsumerRecord = { consumer_id: string; script_name?: string; script?: string;
  dead_letter_queue?: string; settings?: { batch_size?: number; max_concurrency?: number; max_retries?: number } };
type WorkerSettings = {
  bindings?: Array<{ name: string; type: string }>;
  cache_options?: { enabled: boolean; cross_version_cache?: boolean };
  compatibility_flags?: string[];
  logpush?: boolean;
  observability?: object;
  placement?: object;
  tags?: string[];
  tail_consumers?: object[];
};

export class CloudflareApi {
  private readonly base: string;
  private readonly token: string;

  constructor(config: ServiceConfig) {
    if (process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id || !process.env.CLOUDFLARE_API_TOKEN) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this service");
    }
    this.base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.account_id)}`;
    this.token = process.env.CLOUDFLARE_API_TOKEN;
  }

  private async request(method: string, path: string, body?: BodyInit, contentType?: string,
    timeout = 30000): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`,
          ...(contentType ? { "Content-Type": contentType } : {}) },
        ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new Error(`Cloudflare ${method} ${path} could not connect: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const data: ApiResult<unknown> = JSON.parse(text);
        if (data.errors?.length) message += ` (${data.errors.map((item) => `${item.code}: ${item.message}`).join(", ")})`;
      } catch { /* An HTTP status is sufficient when the response is not JSON. */ }
      throw new Error(`Cloudflare ${method} ${path} failed: ${message}`);
    }
    return response;
  }

  private async json<T>(method: string, path: string, value?: object): Promise<T> {
    const response = await this.request(method, path,
      value ? JSON.stringify(value) : undefined, value ? "application/json" : undefined);
    const data: ApiResult<T> = await response.json();
    if (!data.success) throw new Error(`Cloudflare ${method} ${path} did not succeed`);
    return data.result;
  }

  async createBucket(name: string): Promise<void> {
    await this.json("POST", "/r2/buckets", { name });
  }

  async createQueue(name: string): Promise<void> {
    await this.json("POST", "/queues", { queue_name: name });
  }

  async queueId(name: string): Promise<string> {
    for (let page = 1; ; page += 1) {
      const path = `/queues?page=${page}`;
      const response = await this.request("GET", path);
      const data: ApiResult<QueueRecord[]> & { result_info?: { total_pages?: number } } = await response.json();
      if (!data.success) throw new Error(`Cloudflare GET ${path} did not succeed`);
      const id = data.result.find((queue) => queue.queue_name === name)?.queue_id;
      if (id) return id;
      if (page >= (data.result_info?.total_pages ?? 1)) break;
    }
    throw new Error(`Queue ${name} was not found in this Cloudflare account`);
  }

  private async existingWorker(name: string): Promise<WorkerSettings | null> {
    const path = `/workers/scripts/${encodeURIComponent(name)}/settings`;
    const response = await fetch(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cloudflare GET ${path} failed: HTTP ${response.status}`);
    const data: ApiResult<WorkerSettings> = await response.json();
    if (!data.success) throw new Error(`Cloudflare GET ${path} did not succeed`);
    return data.result;
  }

  async deployWorker(config: ServiceConfig, source: string, adminKey: string,
    compatibilityDate: string): Promise<void> {
    const previous = await this.existingWorker(config.worker_name);
    const managed = new Set(["CASTLOOP_BUCKET", "CASTLOOP_QUEUE", "CASTLOOP_DLQ_NAME", "CASTLOOP_ADMIN_KEY"]);
    const preserved = previous?.bindings?.filter((binding) => !managed.has(binding.name))
      .map((binding) => ({ name: binding.name, type: "inherit" })) ?? [];
    const adminSecret = previous?.bindings?.some((binding) => binding.name === "CASTLOOP_ADMIN_KEY")
      ? { name: "CASTLOOP_ADMIN_KEY", type: "inherit" }
      : { name: "CASTLOOP_ADMIN_KEY", type: "secret_text", text: adminKey };
    const metadata = {
      main_module: "index.js", compatibility_date: compatibilityDate,
      cache_options: { enabled: true,
        ...(previous?.cache_options?.cross_version_cache !== undefined
          ? { cross_version_cache: previous.cache_options.cross_version_cache } : {}) },
      observability: previous?.observability ?? { enabled: true, traces: { enabled: true } },
      ...(previous?.compatibility_flags?.length ? { compatibility_flags: previous.compatibility_flags } : {}),
      ...(previous?.tags?.length ? { tags: previous.tags } : {}),
      ...(previous?.tail_consumers?.length ? { tail_consumers: previous.tail_consumers } : {}),
      ...(previous?.placement ? { placement: previous.placement } : {}),
      ...(previous?.logpush ? { logpush: previous.logpush } : {}),
      bindings: [
        { name: "CASTLOOP_BUCKET", type: "r2_bucket", bucket_name: config.bucket_name },
        { name: "CASTLOOP_QUEUE", type: "queue", queue_name: config.queue_name },
        { name: "CASTLOOP_DLQ_NAME", type: "plain_text", text: config.dlq_name },
        adminSecret, ...preserved,
      ],
    };
    const upload = new FormData();
    upload.set("metadata", JSON.stringify(metadata));
    upload.set("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    await this.jsonUpload(`/workers/scripts/${encodeURIComponent(config.worker_name)}?bindings_inherit=strict`, upload);
    await this.json("POST", `/workers/scripts/${encodeURIComponent(config.worker_name)}/subdomain`,
      { enabled: true, previews_enabled: false });
  }

  private async jsonUpload(path: string, body: FormData): Promise<void> {
    const response = await this.request("PUT", path, body, undefined, 120000);
    const data: ApiResult<unknown> = await response.json();
    if (!data.success) throw new Error(`Cloudflare PUT ${path} did not succeed`);
  }

  async ensureConsumer(queueId: string, config: ServiceConfig, dlq: boolean): Promise<void> {
    const path = `/queues/${encodeURIComponent(queueId)}/consumers`;
    const existing = await this.json<ConsumerRecord[]>("GET", path);
    if (existing.length) {
      if (existing.length !== 1 || (existing[0].script_name ?? existing[0].script) !== config.worker_name ||
        existing[0].settings?.batch_size !== 1 || existing[0].settings?.max_concurrency !== 1 ||
        (!dlq && (existing[0].dead_letter_queue !== config.dlq_name ||
          existing[0].settings?.max_retries !== 2))) {
        throw new Error(`Queue ${dlq ? config.dlq_name : config.queue_name} has an unexpected consumer`);
      }
      return;
    }
    await this.json("POST", path, { script_name: config.worker_name, type: "worker",
      ...(dlq ? {} : { dead_letter_queue: config.dlq_name, settings: { batch_size: 1,
        max_concurrency: 1, max_retries: 2 } }),
      ...(dlq ? { settings: { batch_size: 1, max_concurrency: 1 } } : {}),
    });
  }

  async createNotification(config: ServiceConfig, queueId: string): Promise<void> {
    await this.json("PUT", `/event_notifications/r2/${encodeURIComponent(config.bucket_name)}` +
      `/configuration/queues/${encodeURIComponent(queueId)}`, {
      rules: [{ actions: ["PutObject", "CopyObject", "CompleteMultipartUpload"],
        prefix: "staging/", suffix: "commit.json" }],
    });
  }

  async putObject(bucket: string, key: string, file: string, contentType: string,
    checksum?: string): Promise<void> {
    const length = statSync(file).size;
    const path = `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key}`;
    const response = await this.request("PUT", path, Bun.file(file), contentType, 300000);
    const data: ApiResult<{ size: number | string }> = await response.json();
    if (!data.success || Number(data.result?.size) !== length) {
      throw new Error(`R2 upload size mismatch for ${key}`);
    }
    if (checksum) await this.verifyObject(bucket, key, length, checksum);
  }

  private async verifyObject(bucket: string, key: string, length: number, checksum: string): Promise<void> {
    const path = `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key}`;
    const response = await this.request("GET", path, undefined, undefined, 300000);
    if (!response.body) throw new Error(`R2 download for ${key} was empty`);
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      hash.update(chunk);
    }
    if (received !== length || hash.digest("hex") !== checksum) {
      throw new Error(`R2 upload verification failed for ${key}`);
    }
  }
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
