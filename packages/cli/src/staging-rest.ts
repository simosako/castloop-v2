import { serviceConfigSchema, stageReadbackReceiptSchema, stageUploadRequestSchema } from "@castloop/shared";
import type { ServiceConfig, StageReadbackReceipt } from "@castloop/shared";
import { stagingClientTargets } from "./staging-client";
import type { StagePutTarget } from "./staging-client";
import type { FrozenStagingSources } from "./staging-sources";
import { putVerifiedR2Object, requireR2RestOptions } from "./verified-r2-put";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";

export type StagingRestTransport = R2RestTransport;
export type StagingRestOptions = R2RestOptions;

export function createStagingRestPut(configInput: ServiceConfig, sources: FrozenStagingSources,
  options: StagingRestOptions = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" }):
  (target: StagePutTarget, index: number) => Promise<StageReadbackReceipt> {
  const config = serviceConfigSchema.parse(configInput);
  const upload = stageUploadRequestSchema.parse(sources.upload);
  requireR2RestOptions(config.account_id, options);
  const targets = stagingClientTargets(upload);
  const used = new Set<number>();
  const types = { show_metadata: "application/toml", episode_metadata: "application/toml", cover_jpg: "image/jpeg", cover_png: "image/png", audio: "audio/mpeg" };
  return async (target, index) => {
    if (!Number.isInteger(index) || !targets[index] || JSON.stringify(target) !== JSON.stringify(targets[index]) || used.has(index)) {
      throw new Error("Staging REST PUT requires its exact one-time key, size and checksum");
    }
    used.add(index);
    let readback: StageReadbackReceipt | undefined;
    await sources.withPayload(index, async (body, requireConsumed) => {
      const receipt = await putVerifiedR2Object(config, { ...target, contentType: types[upload.payloads[index]!.asset] }, body, requireConsumed, options);
      readback = stageReadbackReceiptSchema.parse({ ...upload.payloads[index], ...receipt });
    });
    if (!readback) throw new Error("Staging readback receipt is missing");
    return readback;
  };
}
