import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildM6WorkerUploadMetadata, m6ServiceConfigHash, m6ServiceUpdateRequestSchema,
  serviceAdmissionSchema, serviceConfigSchema } from "../build/castloop-v2-rss-a8c7e54/packages/shared/src/index";
import { CloudflareApi } from "../build/castloop-v2-rss-a8c7e54/packages/cli/src/cloudflare-api";
import { migrationPayloadHash } from "../build/castloop-v2-rss-a8c7e54/packages/cli/src/migration-deployment";
import { createM6UpdateRestEffects } from "../build/castloop-v2-rss-a8c7e54/packages/cli/src/m6-update-rest";
import { createM6UpdateJournal, readLocalM6Update, resumeM6UpdateDeploymentVerification,
  runM6Update } from "../build/castloop-v2-rss-a8c7e54/packages/cli/src/m6-service-update";

const resultDirectory = "[LOCAL_TEST_ROOT]/evidence/rss-performance-a8c7e54/update-investigation";
const workspace = "[LOCAL_TEST_ROOT]/workspaces/rss-20261012-run1";
const actualJournal = join(workspace, ".castloop/service-updates/rsstest-1012-r1/3ad4f8af-7552-40a2-9525-8bf434a6146e.json");

for (const failure of ["post-upload-settings-get", "activation-post-response-unknown"] as const) {
  test(`offline: ${failure} leaves upload-only journal and refuses automatic replay`, async () => {
    const actualBefore = readFileSync(actualJournal);
    const root = mkdtempSync("[REDACTED_FIXTURE_PATH]");
    const previousVersion = crypto.randomUUID();
    const nextVersion = crypto.randomUUID();
    const previousDeployment = crypto.randomUUID();
    const config = serviceConfigSchema.parse({ schema_version: 1, service_id: "offline-test",
      account_id: "a".repeat(32), bucket_name: "offline-private", worker_name: "castloop-offline-test",
      queue_name: "offline-queue", dlq_name: "offline-dlq", public_base_url: "https://castloop-offline-test.example.workers.dev" });
    const oldMetadata = buildM6WorkerUploadMetadata(config, null, "dummy-offline-secret");
    const metadata = buildM6WorkerUploadMetadata(config, oldMetadata, "");
    metadata.bindings = metadata.bindings.map(binding => binding.type === "inherit"
      ? { ...binding, version_id: previousVersion } : binding);
    const source = "offline-worker-fixture";
    const request = m6ServiceUpdateRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: config.service_id,
      pause_id: crypto.randomUUID(), expected_service_generation: 1, previous_worker_version_id: previousVersion,
      service_config_sha256: await m6ServiceConfigHash(config), worker_source_sha256: migrationPayloadHash(source),
      worker_metadata_sha256: migrationPayloadHash(metadata) });
    const admission = serviceAdmissionSchema.parse({ schema_version: 1, service_id: config.service_id,
      mode: "m6", state: "updating", generation: 2, pause_id: request.pause_id, invocations: [], update: { request },
      runtime_readiness: { operation_id: crypto.randomUUID(), deployment_id: previousDeployment,
        worker_version_id: previousVersion, service_config_sha256: request.service_config_sha256,
        default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
        cutover_verified: true, publication_routes_verified: true } });
    const originalFetch = globalThis.fetch;
    const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const originalToken = process.env.CLOUDFLARE_API_TOKEN;
    const calls: { method: string; endpoint: string }[] = [];
    const writes: string[] = [];
    let uploaded = false;
    process.env.CLOUDFLARE_ACCOUNT_ID = config.account_id;
    process.env.CLOUDFLARE_API_TOKEN = "dummy-offline-token";
    const reply = (result: unknown) => Response.json({ success: true, result });
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const http = new Request(input, init);
      const url = new URL(http.url);
      const endpoint = url.pathname.split("/").at(-1)!;
      calls.push({ method: http.method, endpoint });
      if (http.method !== "GET") writes.push(endpoint);
      if (endpoint === "versions" && http.method === "POST") {
        uploaded = true;
        return reply({ id: nextVersion, number: 2, resources: { script: { etag: "offline-etag" } } });
      }
      if (endpoint === "versions") return reply({ items: uploaded
        ? [{ id: nextVersion, number: 2 }, { id: previousVersion, number: 1 }]
        : [{ id: previousVersion, number: 1 }] });
      if (endpoint === "settings") {
        if (uploaded && failure === "post-upload-settings-get") throw new DOMException("The operation timed out.", "TimeoutError");
        return reply(oldMetadata);
      }
      if (endpoint === "deployments") {
        if (http.method === "POST") throw new DOMException("The operation timed out.", "TimeoutError");
        return reply({ deployments: [{ id: previousDeployment, strategy: "percentage",
          versions: [{ version_id: previousVersion, percentage: 100 }] }] });
      }
      if ([previousVersion, nextVersion].includes(endpoint)) return reply({ id: endpoint, resources: {
        bindings: oldMetadata.bindings, script: { etag: "offline-etag", handlers: ["fetch", "queue"],
          named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
        script_runtime: { compatibility_date: oldMetadata.compatibility_date,
          compatibility_flags: oldMetadata.compatibility_flags, exports: oldMetadata.exports } } });
      if (endpoint === "subdomain") return reply({ enabled: true, previews_enabled: false });
      if (endpoint === "domains") return reply([]);
      throw new Error("Unexpected offline fixture endpoint; network access is never delegated");
    }, { preconnect: originalFetch.preconnect });
    try {
      const api = new CloudflareApi(config);
      const effects = createM6UpdateRestEffects(api, { begin: async () => {}, admission: async () => admission,
        complete: async () => { throw new Error("Completion must never be reached"); } });
      const journal = await createM6UpdateJournal(root, config, request);
      await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("The operation timed out.");
      const retained = readLocalM6Update(root, config, request.operation_id);
      expect(retained.lockPresent).toBe(false);
      expect(retained.state?.phase).toBe("deploy_requested");
      expect(retained.state?.upload_receipt?.id).toBe(nextVersion);
      expect(retained.state?.deployment_receipt).toBeUndefined();
      expect(retained.state?.target).toBeUndefined();
      expect(writes).toEqual(failure === "post-upload-settings-get" ? ["versions"] : ["versions", "deployments"]);
      const beforeRetry = calls.length;
      await expect(runM6Update(journal, effects, source, metadata)).rejects.toThrow("without replay");
      await expect(resumeM6UpdateDeploymentVerification(journal, effects)).rejects.toThrow("both durable");
      expect(calls.length).toBe(beforeRetry);
      expect(readFileSync(actualJournal)).toEqual(actualBefore);
      await Bun.write(join(resultDirectory, `offline-${failure}.json`), JSON.stringify({ failure,
        simulated_only: true, real_cloudflare_requests: 0, fixture_directory: root,
        mocked_writes: writes, retained_phase: retained.state?.phase, upload_receipt_present: true,
        deployment_receipt_present: false, target_present: false,
        normal_replay_rejected_before_any_new_requests: true, verification_rejected_without_both_receipts: true,
        real_workspace_journal_bytes_unchanged: true, mock_calls: calls }, null, 2) + "\n");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
      if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    }
  });
}
