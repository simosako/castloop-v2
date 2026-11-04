import { LOGPUSH_FIELDS } from "../logpush-config";
import { initializeSqliteService } from "../sqlite-initialization";
import { startSqliteDomainChange } from "../sqlite-domain-operation";
import { loadWorkspaceConfig } from "../workspace-config";
import type { R2RestTransport } from "../bounded-http-read";
import { sqliteServiceFixture, TEST_WAIT } from "./sqlite-service";

type Token = { id: string; name: string; status: string; policies: unknown[] };
type Job = { id: number; name: string; dataset: string; enabled: boolean; destination_conf: string; filter: string;
  output_options: { field_names: string[]; sample_rate: number; timestamp_format: string };
  last_complete: string | null; last_error: string | null; error_message: string | null };
export async function logpushFixture() {
  const service = await sqliteServiceFixture();
  await initializeSqliteService(service.root, service.config, crypto.randomUUID(), "worker", service.options, TEST_WAIT);
  const zoneId = "c".repeat(32), permissionId = "d".repeat(32);
  await startSqliteDomainChange(service.root, service.config, "add", crypto.randomUUID(), "worker", service.options,
    { hostname: "podcasts.example.com", zoneId }, TEST_WAIT);
  let config = await loadWorkspaceConfig(service.root);
  const tokens: Token[] = [], jobs: Job[] = [], rules: object[] = [];
  const buckets = new Set<string>();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const faults: { lost?: "bucket" | "lifecycle" | "token" | "job" | "update" | "delete-token";
    public?: boolean; customDomain?: boolean; missingField?: boolean; incompleteTokens?: boolean; failStatus?: number;
    wrongAccount?: boolean; range?: boolean; corruptJson?: boolean; oversized?: boolean } = {};
  const json = (result: unknown) => Response.json({ success: true, errors: [], result });
  const lost = (name: NonNullable<typeof faults.lost>) => { if (faults.lost === name) throw new Error("private-token destination-secret private@example.com"); };
  let sequence = 0;
  const transport: R2RestTransport = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return service.transport(input, init);
    const path = url.pathname.replace(`/client/v4/accounts/${config.account_id}`, "").replace("/client/v4", "");
    if (!path.includes("logpush") && !path.startsWith("/tokens") &&
      !path.startsWith("/r2/buckets/access-logs") && !(path === "/r2/buckets" && request.method === "POST") && path !== `/zones/${zoneId}`) {
      return service.transport(input, init);
    }
    if (request.headers.get("Authorization") !== "Bearer private-token") return new Response(null, { status: 403 });
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json();
    calls.push({ method: request.method, path: `${path}${url.search}`, ...(body ? { body } : {}) });
    if (faults.failStatus) return new Response("destination-secret private@example.com", { status: faults.failStatus });
    if (faults.range) return new Response("destination-secret", { headers: { "Content-Range": "bytes 0-17/18" } });
    if (faults.corruptJson) return new Response("destination-secret private@example.com");
    if (faults.oversized) return new Response("x".repeat(1_000_001));
    if (path === `/zones/${zoneId}`) return json({ id: zoneId, name: "example.com", status: "active", type: "full",
      account: { id: faults.wrongAccount ? "e".repeat(32) : config.account_id } });
    if (path.endsWith("/logpush/datasets/http_requests/fields")) return json(Object.fromEntries(
      LOGPUSH_FIELDS.filter((field) => !faults.missingField || field !== "ClientRequestPath").map((field) => [field, "Field description"])));
    if (path === "/r2/buckets") {
      const { name } = body as { name: string }; buckets.add(name); lost("bucket"); return json({ name });
    }
    if (path.startsWith("/r2/buckets/access-logs")) {
      const bucketName = path.split("/")[3]!;
      if (!buckets.has(bucketName)) return new Response(null, { status: 404 });
      if (path.endsWith("/domains/managed")) return json({ enabled: faults.public ?? false });
      if (path.endsWith("/domains/custom")) return json({ domains: faults.customDomain ? [{ enabled: true }] : [] });
      if (path.endsWith("/lifecycle")) {
        if (request.method === "PUT") { rules.splice(0, rules.length, ...(body as { rules: object[] }).rules); lost("lifecycle"); return json({}); }
        return json({ rules });
      }
      return json({ name: bucketName, storage_class: "Standard", jurisdiction: "default" });
    }
    if (path === "/tokens/permission_groups") return json([{ id: permissionId, name: "Workers R2 Storage Bucket Item Write" }]);
    if (path === "/tokens") {
      if (request.method === "POST") {
        const value = body as { name: string; policies: unknown[] };
        const token = { id: (++sequence).toString(16).padStart(32, "0"), name: value.name, status: "active", policies: value.policies };
        tokens.push(token); lost("token"); return json({ ...token, value: "destination-secret" });
      }
      const page = Number(url.searchParams.get("page")), items = tokens.slice((page - 1) * 50, page * 50);
      return Response.json({ success: true, result: items.map((token) => ({ ...token, creator_email_at_creation: "private@example.com" })),
        result_info: { page, per_page: 50, count: items.length, total_count: tokens.length + (faults.incompleteTokens ? 1 : 0) } });
    }
    if (path.startsWith("/tokens/")) {
      const tokenId = path.split("/").at(-1)!;
      const index = tokens.findIndex((token) => token.id === tokenId);
      if (index < 0) return new Response(null, { status: 404 });
      tokens.splice(index, 1); lost("delete-token"); return json({ id: tokenId });
    }
    if (path === `/zones/${zoneId}/logpush/jobs`) {
      if (request.method === "POST") {
        const job = { ...(body as Omit<Job, "id" | "last_complete" | "last_error" | "error_message">),
          id: ++sequence, last_complete: null, last_error: null, error_message: null };
        jobs.push(job); lost("job"); return json(job);
      }
      return json(jobs);
    }
    if (path.startsWith(`/zones/${zoneId}/logpush/jobs/`)) {
      const job = jobs.find((job) => job.id === Number(path.split("/").at(-1)))!;
      Object.assign(job, body); lost("update"); return json(job);
    }
    throw new Error(`Unhandled test Logpush route ${request.method} ${path}`);
  };
  return { service, root: service.root, close: () => service.close(), config, zoneId, permissionId, tokens, jobs, rules, buckets, calls, faults,
    transport, options: { ...service.options, transport },
    async changeHost(host: string) {
      if (config.public_base_url !== config.workers_dev_base_url) {
        await startSqliteDomainChange(service.root, config, "remove", crypto.randomUUID(), "worker", service.options, undefined, TEST_WAIT);
        config = await loadWorkspaceConfig(service.root);
      }
      if (`https://${host}` !== config.workers_dev_base_url) {
        await startSqliteDomainChange(service.root, config, "add", crypto.randomUUID(), "worker", service.options,
          { hostname: host, zoneId }, TEST_WAIT);
        config = await loadWorkspaceConfig(service.root);
      }
      return config;
    } };
}
