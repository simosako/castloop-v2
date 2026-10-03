import { describe, expect, test } from "bun:test";
import { collectM6DeploymentSnapshot, m6SnapshotReads, m6WorkerDeploymentEvidenceSchema, serviceConfigSchema } from "@castloop/shared";
import { buildM6WorkerUploadMetadata, inspectM6WorkerDeployment, M6_WORKER_COMPATIBILITY_DATE } from "./m6-worker-deployment";
import type { M6DeploymentReads } from "./m6-worker-deployment";

const M6_DEPLOYMENT_CONFIG = serviceConfigSchema.parse({ schema_version: 1, service_id: "probe", account_id: "a".repeat(32),
  bucket_name: "probe-bucket", worker_name: "probe-worker", queue_name: "probe-queue", dlq_name: "probe-dlq",
  public_base_url: "https://probe-worker.example.workers.dev" });

function deploymentFixture() {
  const metadata = buildM6WorkerUploadMetadata(M6_DEPLOYMENT_CONFIG, null, "private-admin-secret");
  const workerVersionId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const deployments = { deployments: [{ id: deploymentId, strategy: "percentage", versions: [{ version_id: workerVersionId, percentage: 100 }],
    author_email: "private@example.com", annotations: { "workers/message": "Private deployment note" } }] };
  const settings = { ...metadata, unrelated: { secret: "private" } };
  const version = { id: workerVersionId, metadata: { author_email: "private@example.com" }, resources: { bindings: structuredClone(metadata.bindings),
    script: { handlers: ["fetch", "queue"], named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
    script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: [...metadata.compatibility_flags], exports: structuredClone(metadata.exports) } } };
  const subdomain = { enabled: true, previews_enabled: false };
  const reads: M6DeploymentReads = { deployments: async () => deployments, settings: async () => settings, version: async () => version,
    subdomain: async () => subdomain };
  return { metadata, workerVersionId, deploymentId, deployments, settings, version, subdomain, reads };
}

describe("M6 REST upload metadata preparation", () => {
  test("uncached default, named cache isolation, version metadata and telemetry are explicit", () => {
    const metadata = buildM6WorkerUploadMetadata(M6_DEPLOYMENT_CONFIG, null, "private-admin-secret");
    expect(metadata.cache_options).toEqual({ enabled: true, cross_version_cache: false });
    expect(metadata.exports).toEqual({ default: { type: "worker", cache: { enabled: false } }, CachedPublicAssets: { type: "worker", cache: { enabled: true } } });
    expect(metadata.bindings.filter((binding) => binding.name === "CASTLOOP_VERSION_METADATA")).toEqual([{ name: "CASTLOOP_VERSION_METADATA", type: "version_metadata" }]);
    expect(metadata.compatibility_date).toBe(M6_WORKER_COMPATIBILITY_DATE);
    expect(metadata.compatibility_flags).toContain("enable_ctx_exports");
    expect(metadata.observability.enabled).toBe(true);
    expect(metadata.observability.logs.enabled).toBe(true);
    expect(metadata.observability.traces.enabled).toBe(true);
  });

  test("preserves unrelated bindings/settings without copying retrieved secrets or replacing the admin key", () => {
    const previous = { bindings: [{ name: "CASTLOOP_ADMIN_KEY", type: "secret_text", text: "old-admin-secret" },
      { name: "EXTRA_SECRET", type: "secret_text", text: "extra-secret" }, { name: "CASTLOOP_VERSION_METADATA", type: "plain_text", text: "false-version" }],
      cache_options: { enabled: true, cross_version_cache: true }, compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
      observability: { enabled: false, logs: { enabled: false, destinations: ["cloudflare"] }, traces: { enabled: false, head_sampling_rate: 0.01 } },
      tags: ["retained-tag"], tail_consumers: [{ service: "log-worker" }], placement: { mode: "smart" }, logpush: true };
    const metadata = buildM6WorkerUploadMetadata(M6_DEPLOYMENT_CONFIG, previous, "replacement-secret");
    expect(metadata.bindings.filter((binding) => binding.type === "inherit")).toEqual([
      { name: "CASTLOOP_ADMIN_KEY", type: "inherit" }, { name: "EXTRA_SECRET", type: "inherit" }]);
    expect(metadata.compatibility_flags).toEqual(["nodejs_compat", "enable_ctx_exports"]);
    expect(metadata.observability.traces.head_sampling_rate).toBe(0.01);
    expect(metadata.observability.logs.destinations).toEqual(["cloudflare"]);
    expect(metadata.tags).toEqual(previous.tags);
    expect(metadata.tail_consumers).toEqual(previous.tail_consumers);
    expect(metadata.placement).toEqual(previous.placement);
    expect(metadata.logpush).toBe(true);
    for (const secret of ["old-admin-secret", "extra-secret", "replacement-secret", "false-version"]) expect(JSON.stringify(metadata)).not.toContain(secret);
  });

  test("rejects ambiguous bindings, nonsecret admin bindings and incompatible loopback flags", () => {
    for (const previous of [{ bindings: [{ name: "CASTLOOP_ADMIN_KEY", type: "plain_text" }] },
      { bindings: [], compatibility_flags: ["disable_ctx_exports"] },
      { bindings: [{ name: "X", type: "plain_text" }, { name: "X", type: "secret_text" }] }]) {
      expect(() => buildM6WorkerUploadMetadata(M6_DEPLOYMENT_CONFIG, previous, "private-admin-secret")).toThrow();
    }
    expect(() => buildM6WorkerUploadMetadata(M6_DEPLOYMENT_CONFIG, null, "")).toThrow("administrator secret");
  });
});

describe("read-only M6 deployment and runtime inspection", () => {
  test("returns only allowlisted evidence after repeated deployment/settings/subdomain reads", async () => {
    const setup = deploymentFixture();
    const calls: string[] = [];
    const reads: M6DeploymentReads = { deployments: async () => { calls.push("deployments"); return setup.deployments; },
      version: async (id) => { calls.push(`version:${id}`); return setup.version; },
      settings: async () => { calls.push("settings"); return setup.settings; }, subdomain: async () => { calls.push("subdomain"); return setup.subdomain; } };
    const value = await inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, reads);
    expect(value.deployment_id).toBe(setup.deploymentId);
    expect(value.worker_version_id).toBe(setup.workerVersionId);
    expect(value.default_cache_disabled).toBe(true);
    expect(calls).toEqual(["deployments", `version:${setup.workerVersionId}`, "settings", "subdomain", "settings", "subdomain", "deployments"]);
    for (const privateValue of ["private-admin-secret", "private@example.com", "Private deployment note", "unrelated", "old_cache_purged", "old_io_quiesced", "cutover_verified"]) {
      expect(JSON.stringify(value)).not.toContain(privateValue);
    }
    expect(m6WorkerDeploymentEvidenceSchema.safeParse({ ...value, old_cache_purged: true }).success).toBe(false);
    const snapshot = await collectM6DeploymentSnapshot(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, setup.reads, M6_WORKER_COMPATIBILITY_DATE);
    expect(await inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, m6SnapshotReads(snapshot))).toEqual(value);
    for (const privateValue of ["private-admin-secret", "private@example.com", "Private deployment note", "unrelated"]) {
      expect(JSON.stringify(snapshot)).not.toContain(privateValue);
    }
    const { exports: _exports, ...settingsWithoutExports } = setup.settings;
    const observed = { ...setup.reads, settings: async () => settingsWithoutExports };
    expect(await inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, observed)).toEqual(value);
    const withoutExports = await collectM6DeploymentSnapshot(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, observed, M6_WORKER_COMPATIBILITY_DATE);
    expect(withoutExports.settings[0].exports).toBeUndefined();
    expect(await inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, m6SnapshotReads(withoutExports))).toEqual(value);
    setup.version.resources.script_runtime.exports.default.cache.enabled = true;
    await expect(inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, observed)).rejects.toThrow("uncached default");
  });

  test("partial rollout, wrong version and missing deployment are rejected before runtime reads", async () => {
    const setup = deploymentFixture();
    for (const deployments of [{ deployments: [] }, { deployments: [{ ...setup.deployments.deployments[0], versions: [{ version_id: setup.workerVersionId, percentage: 99 }] }] },
      { deployments: [{ ...setup.deployments.deployments[0], versions: [{ version_id: crypto.randomUUID(), percentage: 100 }] }] },
      { deployments: [{ ...setup.deployments.deployments[0], versions: [{ version_id: setup.workerVersionId, percentage: 100 }, { version_id: crypto.randomUUID(), percentage: 0 }] }] }]) {
      let reads = 0;
      await expect(inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, { ...setup.reads,
        deployments: async () => deployments, version: async () => { reads += 1; return setup.version; } })).rejects.toThrow();
      expect(reads).toBe(0);
    }
  });

  test("version and current settings each require explicit gateway/cache isolation and owned bindings", async () => {
    for (const scope of ["version", "settings"] as const) {
      for (const change of ["default-cache", "named-cache", "exports", "binding", "metadata", "flags", "date"] as const) {
        const setup = deploymentFixture();
        const target = scope === "version" ? setup.version.resources.script_runtime : setup.settings;
        if (change === "default-cache") target.exports.default.cache.enabled = true;
        if (change === "named-cache") target.exports.CachedPublicAssets.cache.enabled = false;
        if (change === "exports") Object.assign(target.exports, { Ungated: { type: "worker", cache: { enabled: true } } });
        if (change === "flags") target.compatibility_flags = ["disable_ctx_exports"];
        if (change === "date") target.compatibility_date = "2026-09-30";
        if (change === "binding" || change === "metadata") {
          const bindings = scope === "version" ? setup.version.resources.bindings : setup.settings.bindings;
          const binding = bindings.find((binding) => binding.name === (change === "binding" ? "CASTLOOP_BUCKET" : "CASTLOOP_VERSION_METADATA"))!;
          if (change === "binding") Object.assign(binding, { bucket_name: "another-bucket" });
          else binding.type = "plain_text";
        }
        await expect(inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, setup.reads)).rejects.toThrow();
      }
    }
  });

  test("cross-version cache, unavailable telemetry and version-preview routes fail closed", async () => {
    for (const change of ["cross-version", "cache-disabled", "logs", "traces", "previews", "workers-dev", "handlers"] as const) {
      const setup = deploymentFixture();
      if (change === "cross-version") setup.settings.cache_options.cross_version_cache = true;
      if (change === "cache-disabled") setup.settings.cache_options.enabled = false;
      if (change === "logs") setup.settings.observability.logs.enabled = false;
      if (change === "traces") setup.settings.observability.traces.enabled = false;
      if (change === "previews") setup.subdomain.previews_enabled = true;
      if (change === "workers-dev") setup.subdomain.enabled = false;
      if (change === "handlers") setup.version.resources.script.handlers = ["fetch"];
      await expect(inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, setup.reads)).rejects.toThrow();
    }
  });

  test("rollout changes, setting changes and preview changes during inspection are not accepted", async () => {
    for (const change of ["deployment", "settings", "subdomain"] as const) {
      const setup = deploymentFixture();
      let calls = 0;
      const reads = { ...setup.reads };
      if (change === "deployment") reads.deployments = async () => ++calls === 1 ? setup.deployments :
        { deployments: [{ ...setup.deployments.deployments[0], id: crypto.randomUUID() }] };
      if (change === "settings") reads.settings = async () => ++calls === 1 ? setup.settings :
        { ...setup.settings, compatibility_flags: [...setup.settings.compatibility_flags, "nodejs_compat"] };
      if (change === "subdomain") reads.subdomain = async () => ++calls === 1 ? setup.subdomain : { enabled: true, previews_enabled: true };
      await expect(inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, reads)).rejects.toThrow("changed");
    }
  });

  test("GET response field order and unrelated metadata are not persistence input", async () => {
    const setup = deploymentFixture();
    let calls = 0;
    const value = await inspectM6WorkerDeployment(M6_DEPLOYMENT_CONFIG, setup.workerVersionId, { ...setup.reads,
      settings: async () => ++calls === 1 ? setup.settings : { ...setup.settings,
        bindings: [...setup.settings.bindings].reverse(), cache_options: { cross_version_cache: false, enabled: true },
        exports: { CachedPublicAssets: setup.settings.exports.CachedPublicAssets, default: setup.settings.exports.default },
        unrelated: { secret: "different-private-value" } } });
    expect(value.worker_version_id).toBe(setup.workerVersionId);
  });
});
