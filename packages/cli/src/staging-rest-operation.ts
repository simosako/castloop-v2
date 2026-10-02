import type { ServiceConfig } from "@castloop/shared";
import { createStagingOperationEffects } from "./staging-operation";
import type { StagingOperationEffects } from "./staging-operation";
import { createStagingRestPut } from "./staging-rest";
import type { StagingRestOptions } from "./staging-rest";
import type { FrozenStagingSources } from "./staging-sources";
import type { StagingAdminClient } from "./staging-client";
import type { StagingClientState } from "./staging-journal";

export function createStagingRestEffects(config: ServiceConfig, state: StagingClientState, adminKey: string,
  sources: FrozenStagingSources, options?: StagingRestOptions,
  client?: Pick<StagingAdminClient, "claim" | "begin" | "settle" | "finish" | "status">): StagingOperationEffects {
  const effects = createStagingOperationEffects(config, state, adminKey, createStagingRestPut(config, sources, options), client);
  if (JSON.stringify(effects.upload) !== JSON.stringify(sources.upload)) throw new Error("REST staging sources differ from the durable frozen manifest");
  return { ...effects,
    claim: async () => { await sources.assertCurrent(); return effects.claim(); },
    begin: async () => { await sources.assertCurrent(); return effects.begin(); },
  };
}
