import { m6SetupQueueProbeSchema, m6SetupRecordSchema } from "../packages/shared/src/index";
import type { M6InitializationEnv } from "./m6-service-initialization";
import { readM6RuntimeConfiguration } from "./m6-runtime-readiness";
import { m6SetupRecordKey, readM6SetupRecord, requireM6SetupOwner } from "./m6-setup-record";

export async function consumeM6SetupProbe(batch: { queue: string; messages: readonly Pick<Message<unknown>, "body">[] },
  env: M6InitializationEnv): Promise<boolean> {
  if (batch.messages.length !== 1) return false;
  const message = batch.messages[0]!;
  if (!message.body || typeof message.body !== "object" || !("type" in message.body) || message.body.type !== "castloop-runtime-probe-v1") return false;
  const { type: _type, ...request } = m6SetupQueueProbeSchema.parse(message.body);
  const { config } = await readM6RuntimeConfiguration(env, request.target.service_config_sha256, env.CASTLOOP_VERSION_METADATA.id);
  if (batch.queue !== config.queue_name) throw new Error("Runtime probe arrived through another Queue");
  const record = await readM6SetupRecord(env, request);
  if (!record) throw new Error("Runtime Queue probe has no retained request");
  if (record.value.queue_receipt) return true;
  await requireM6SetupOwner(env, request);
  if (!record.value.queue_receipt) {
    const next = m6SetupRecordSchema.parse({ ...record.value, queue_receipt: {
      worker_version_id: env.CASTLOOP_VERSION_METADATA.id,
    } });
    if (!await env.CASTLOOP_BUCKET.put(m6SetupRecordKey(request.target.operation_id), JSON.stringify(next), { onlyIf: { etagMatches: record.etag } })) {
      const current = await readM6SetupRecord(env, request);
      if (!current?.value.queue_receipt) throw new Error("Runtime Queue probe receipt conflicted");
    }
  }
  return true;
}
