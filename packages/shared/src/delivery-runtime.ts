import { z } from "zod";

export const cachedDeliveryRuntimeSchema = z.object({
  schema_version: z.literal(1),
  protocol: z.literal("m6-cached-assets-v1"),
  entrypoint: z.literal("CachedPublicAssets"),
  worker_version_id: z.uuid(),
  purge_api_available: z.literal(true),
}).strict();

export type CachedDeliveryRuntime = z.infer<typeof cachedDeliveryRuntimeSchema>;
