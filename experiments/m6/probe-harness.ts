import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ApiEnvelope<T = Record<string, unknown>> = { success: boolean; result: T; errors?: unknown[] };

export class CloudflareProbe {
  readonly name = `castloop-m6-admission-${crypto.randomUUID().slice(0, 12)}`;
  readonly directory = resolve("/tmp/opencode", this.name);
  private readonly secret = crypto.randomUUID() + crypto.randomUUID();
  private readonly account = process.env.CLOUDFLARE_ACCOUNT_ID;
  private readonly token = process.env.CLOUDFLARE_API_TOKEN;
  private createdBucket = false;
  private createdWorker = false;
  private healthy = false;
  private baseUrl = "";
  settings: unknown;
  readonly observations: Array<{ action: string; status: number; data: unknown }> = [];
  readonly cleanupAttempts: Array<{ path: string; attempt: number; error?: string }> = [];

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.account || !this.token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return fetch(`https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`, {
      ...init, headers, signal: init.signal ?? AbortSignal.timeout(60000),
    });
  }

  async api<T = Record<string, unknown>>(method: string, path: string, body?: BodyInit, optional = false): Promise<ApiEnvelope<T> | null> {
    const response = await this.raw(path, { method, body,
      headers: typeof body === "string" ? { "Content-Type": "application/json" } : {} });
    if (optional && response.status === 404) return null;
    let data: ApiEnvelope<T>;
    try { data = await response.json() as ApiEnvelope<T>; }
    catch { throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}, non-JSON response`); }
    if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`);
    return data;
  }

  async start(workerFile: string): Promise<void> {
    await mkdir(this.directory, { mode: 0o700 });
    await writeFile(`${this.directory}/manifest.json`, JSON.stringify({ name: this.name, account: this.account,
      secret: this.secret }), { mode: 0o600 });
    const subdomain = await this.api("GET", "/workers/subdomain");
    assert.equal(typeof subdomain?.result.subdomain, "string");
    this.baseUrl = `https://${this.name}.${subdomain!.result.subdomain}.workers.dev`;
    assert.equal(await this.api("GET", `/workers/scripts/${this.name}/settings`, undefined, true), null);
    assert.equal(await this.api("GET", `/r2/buckets/${this.name}`, undefined, true), null);
    this.createdBucket = true;
    await this.api("POST", "/r2/buckets", JSON.stringify({ name: this.name }));
    const build = await Bun.build({ entrypoints: [workerFile], target: "browser", format: "esm",
      external: ["cloudflare:*"], minify: false });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    assert.equal(build.outputs.length, 1);
    const metadata = { main_module: "worker.js", compatibility_date: "2026-09-30", cache_options: { enabled: false },
      bindings: [{ type: "r2_bucket", name: "CASTLOOP_BUCKET", bucket_name: this.name },
        { type: "secret_text", name: "M6_SECRET", text: this.secret }],
      observability: { enabled: true, head_sampling_rate: 1,
        logs: { enabled: true }, traces: { enabled: true, head_sampling_rate: 1 } } };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.set("worker.js", new Blob([await build.outputs[0].text()], { type: "application/javascript+module" }), "worker.js");
    this.createdWorker = true;
    await this.api("PUT", `/workers/scripts/${this.name}`, form);
    await this.api("POST", `/workers/scripts/${this.name}/subdomain`, JSON.stringify({ enabled: true, previews_enabled: false }));
    const result = await this.api("GET", `/workers/scripts/${this.name}/settings`);
    this.settings = { usage_model: result?.result.usage_model, cache_options: result?.result.cache_options };
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(this.baseUrl + "/health", { signal: AbortSignal.timeout(5000) });
        if (response.ok && (await response.json() as { probe?: string }).probe === "m6-admission-v1") {
          this.healthy = true;
          return;
        }
      } catch {}
      await Bun.sleep(1000);
    }
    throw new Error("Probe health did not converge within 120 seconds");
  }

  private async callOnce(action: string, fields: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await fetch(this.baseUrl + "/admin", { method: "POST", headers: {
      "X-M6-Key": this.secret, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...fields }),
      signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; }
    catch {
      data = { error: "non-JSON response", title: /<title>([^<]*)<\/title>/i.exec(text)?.[1],
        ray: response.headers.get("Cf-Ray") };
    }
    this.observations.push({ action, status: response.status, data });
    return { status: response.status, data };
  }

  async call(action: string, fields: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.callOnce(action, fields);
      if (action === "abandon-lost" || ![429, 500, 502, 503, 504].includes(result.status) || attempt === 3) return result;
      await Bun.sleep(1000 * 2 ** attempt);
    }
  }

  async ok(action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.call(action, fields);
    assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.data)}`);
    return result.data;
  }

  async objectPut(key: string, body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    if (!/^probe\/[a-z0-9-]+$/.test(key)) throw new Error("Only probe upload keys are allowed");
    return this.raw(`/r2/buckets/${this.name}/objects/${encodeURIComponent(key)}`, { method: "PUT", body,
      headers: { "Content-Type": "application/octet-stream", ...headers }, signal });
  }

  async cleanup(): Promise<string[]> {
    const errors: string[] = [];
    if (this.healthy) {
      try { await this.ok("cleanup"); }
      catch {
        try {
          for (;;) {
            const page = await this.api<Array<{ key: string }>>("GET", `/r2/buckets/${this.name}/objects?per_page=100`);
            const objects = page?.result;
            assert.ok(Array.isArray(objects));
            if (!objects.length) break;
            await this.api("DELETE", `/r2/buckets/${this.name}/objects`, JSON.stringify(objects.map((object) => object.key)));
          }
        } catch (error) { errors.push(String(error)); }
      }
    }
    for (const path of [this.createdWorker ? `/workers/scripts/${this.name}` : "",
      this.createdBucket ? `/r2/buckets/${this.name}` : ""]) {
      if (!path) continue;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          await this.api("DELETE", path, undefined, true);
          assert.equal(await this.api("GET", path.startsWith("/workers/") ? `${path}/settings` : path,
            undefined, true), null);
          this.cleanupAttempts.push({ path, attempt });
          break;
        } catch (error) {
          this.cleanupAttempts.push({ path, attempt, error: String(error) });
          if (attempt === 4) errors.push(String(error));
          else await Bun.sleep(1000 * 2 ** (attempt - 1));
        }
      }
    }
    return errors;
  }

  async saveResult(result: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify({ name: this.name, settings: this.settings, ...result,
      observations: this.observations, cleanupAttempts: this.cleanupAttempts, finishedAt: new Date().toISOString() }, null, 2);
    assert.ok(!text.includes(this.secret));
    if (this.token) assert.ok(!text.includes(this.token));
    await writeFile(`${this.directory}/results.json`, text + "\n");
    console.log(`Results: ${this.directory}/results.json`);
  }
}
