import { frozenMigrationPlanSchema, m6WorkerDeploymentEvidenceSchema, parsePublicAssetPath, serviceConfigSchema } from "@castloop/shared";
import type { FrozenMigrationPlan, ServiceConfig } from "@castloop/shared";
import { createHash } from "node:crypto";

type Asset = { path: string; etag: string; size: number; status: 200 | 404 | 410 };
export type MigrationPublicTransport = (url: string, init: RequestInit) => Promise<Response>;
export type MigrationPublicInspection = {
  schema_version: 1; service_id: string; migration_id: string; worker_version_id: string; public_origin: string;
  plan_sha256: string; first_asset: number; next_asset: number; total_assets: number; assets_checked: number; checks_sha256: string;
  snapshot_only: true; authorizes_completion: false; authorizes_mutation: false; payloads_verified: false; routing_scope_verified: false;
};

function publicAssets(plan: FrozenMigrationPlan): Asset[] {
  const assets: Asset[] = [];
  for (const source of plan.sources) {
    if (!source.key.startsWith("public/podcasts/")) continue;
    const path = source.key.slice(6);
    const asset = parsePublicAssetPath(path);
    if (!asset) throw new Error("Migration HTTP inventory contains an unsupported public path");
    const show = plan.shows.find((show) => show.show_id === asset.showId);
    const episode = asset.kind === "audio" ? show?.episodes.find((episode) => episode.episode_id === asset.episodeId) : undefined;
    if (!show || asset.kind === "audio" && !episode) throw new Error("Migration HTTP inventory has no frozen lifecycle target");
    const status = show.value.lifecycle === "deleted" ? 410 : show.value.lifecycle !== "active" ? 404 :
      episode?.value.lifecycle === "deleted" ? 410 : episode && episode.value.lifecycle !== "active" ? 404 : 200;
    if (status === 200 && source.size === 0) throw new Error("Migration HTTP inventory cannot range-probe an empty public asset");
    assets.push({ path, etag: `"${source.etag}"`, size: source.size, status });
  }
  return assets;
}

async function readOneByte(response: Response): Promise<void> {
  if (!response.body) throw new Error("Migration HTTP Range response has no body");
  const reader = response.body.getReader();
  let length = 0;
  let reads = 0;
  try {
    for (;;) {
      reads += 1;
      if (reads > 16) throw new Error("Migration HTTP Range response did not terminate within its read budget");
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1) throw new Error("Migration HTTP Range response exceeds one byte");
    }
    if (length !== 1) throw new Error("Migration HTTP Range response is incomplete");
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

async function inspectAsset(origin: string, asset: Asset, versionId: string, migrationId: string,
  transport: MigrationPublicTransport): Promise<number[]> {
  const observed: number[] = [];
  for (const [method, extra, expected] of [["HEAD", {}, asset.status], ["GET", {}, asset.status],
    ["GET", { Range: "bytes=0-0" }, asset.status === 200 ? 206 : asset.status],
    ["GET", { "If-None-Match": asset.etag }, asset.status === 200 ? 304 : asset.status]] as const) {
    const url = `${origin}${asset.path}`;
    const response = await transport(url, { method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "Accept-Encoding": "identity", ...extra } });
    try {
      if (response.bodyUsed || response.body?.locked || response.redirected || response.url && response.url !== url || response.status !== expected ||
        response.headers.get("X-Castloop-Worker-Version") !== versionId || response.headers.get("X-Castloop-Migration-ID") !== migrationId ||
        response.headers.get("Cache-Control") !== (asset.status === 200 ? "public, max-age=0, must-revalidate" : "no-store")) {
        throw new Error("Migration public HTTP response failed its state, origin, version or cache check");
      }
      if (asset.status === 200) {
        if (response.headers.get("ETag") !== asset.etag || response.headers.get("Content-Encoding") && response.headers.get("Content-Encoding") !== "identity") {
          throw new Error("Migration public HTTP response differs from its frozen source or encoding");
        }
        if ((method === "HEAD" || expected === 200) && response.headers.get("Content-Length") !== String(asset.size)) {
          throw new Error("Migration public HTTP response size differs from its frozen source");
        }
        if (expected === 206) {
          if (response.headers.get("Content-Range") !== `bytes 0-0/${asset.size}` || response.headers.get("Content-Length") !== "1") {
            throw new Error("Migration public HTTP Range response failed");
          }
          await readOneByte(response);
        }
      }
      observed.push(response.status);
    } finally { if (response.body && !response.body.locked) await response.body.cancel(); }
  }
  return observed;
}

export async function inspectMigrationPublicDelivery(configInput: ServiceConfig, planInput: FrozenMigrationPlan, workerVersionId: string,
  options: { firstAsset?: number; maximumAssets?: number; transport?: MigrationPublicTransport } = {}): Promise<MigrationPublicInspection> {
  try {
    const config = serviceConfigSchema.parse(configInput);
    const plan = frozenMigrationPlanSchema.parse(planInput);
    m6WorkerDeploymentEvidenceSchema.shape.worker_version_id.parse(workerVersionId);
    const base = new URL(config.public_base_url);
    if (base.pathname !== "/" || base.search || base.hash || config.service_id !== plan.service_id) {
      throw new Error("Migration HTTP inspection requires the frozen service and exact public origin");
    }
    const assets = publicAssets(plan);
    const first = options.firstAsset ?? 0;
    const maximum = options.maximumAssets ?? 2;
    if (!Number.isSafeInteger(first) || first < 0 || first > assets.length || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20) {
      throw new Error("Migration HTTP inspection page is out of bounds");
    }
    const end = Math.min(assets.length, first + maximum);
    const transport = options.transport ?? fetch;
    const checks = createHash("sha256");
    for (let index = first; index < end; index += 1) {
      const asset = assets[index]!;
      const observations = await inspectAsset(base.origin, asset, workerVersionId, plan.migration_id, transport);
      checks.update(JSON.stringify({ index, path: asset.path, observations }));
    }
    return { schema_version: 1, service_id: config.service_id, migration_id: plan.migration_id, worker_version_id: workerVersionId,
      public_origin: base.origin, plan_sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      first_asset: first, next_asset: end, total_assets: assets.length, assets_checked: end - first, checks_sha256: checks.digest("hex"),
      snapshot_only: true, authorizes_completion: false, authorizes_mutation: false, payloads_verified: false, routing_scope_verified: false };
  } catch { throw new Error("Migration public HTTP inspection failed; no mutation or completion is authorized"); }
}
