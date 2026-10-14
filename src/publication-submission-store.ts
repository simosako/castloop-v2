import { publicationCommitIntentSchema, publicationIntentHash, publicationSubmissionRecordSchema } from "../packages/shared/src/index";
import type { PublicationCommitIntent, PublicationSubmissionRecord } from "../packages/shared/src/index";
import type { LifecycleControlEnv, LifecycleReadEnv } from "./lifecycle-control";

export class PublicationSubmissionConflict extends Error {
  constructor() { super("Publication submission differs from its retained identity"); }
}

export function publicationSubmissionKey(jobId: string): string {
  return `system/jobs/${publicationCommitIntentSchema.shape.operation.shape.job_id.parse(jobId)}/queue-submission.json`;
}

export async function readPublicationSubmission(env: LifecycleReadEnv, jobId: string):
  Promise<{ value: PublicationSubmissionRecord; etag: string } | null> {
  const object = await env.CASTLOOP_BUCKET.get(publicationSubmissionKey(jobId));
  if (!object) return null;
  if (object.size < 1 || object.size > 8192) { await object.body?.cancel(); throw new PublicationSubmissionConflict(); }
  const value = publicationSubmissionRecordSchema.parse(await object.json<unknown>());
  if (value.intent.operation.job_id !== jobId || await publicationIntentHash(value.intent) !== value.result.intent_sha256) {
    throw new PublicationSubmissionConflict();
  }
  return { value, etag: object.etag };
}

export async function retainPublicationSubmission(env: LifecycleControlEnv, intent: PublicationCommitIntent): Promise<PublicationSubmissionRecord> {
  const source = JSON.stringify(publicationCommitIntentSchema.parse(intent));
  const identityKey = `system/publication-submissions/${intent.submission_id}.json`;
  const written = await env.CASTLOOP_BUCKET.put(identityKey, source, { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!written) {
    const existing = await env.CASTLOOP_BUCKET.get(identityKey);
    if (!existing) throw new PublicationSubmissionConflict();
    if (existing.size > 4096) { await existing.body?.cancel(); throw new PublicationSubmissionConflict(); }
    if (await existing.text() !== source) throw new PublicationSubmissionConflict();
  }
  const value = publicationSubmissionRecordSchema.parse({ schema_version: 1, intent, result: {
    submission_id: intent.submission_id, intent_sha256: await publicationIntentHash(intent), state: "pending",
  } });
  const jobWritten = await env.CASTLOOP_BUCKET.put(publicationSubmissionKey(intent.operation.job_id), JSON.stringify(value), {
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (jobWritten) return value;
  const current = await readPublicationSubmission(env, intent.operation.job_id);
  if (!current || JSON.stringify(current.value.intent) !== source) throw new PublicationSubmissionConflict();
  return current.value;
}

export async function advancePublicationSubmission(env: LifecycleControlEnv, intent: PublicationCommitIntent,
  state: PublicationSubmissionRecord["result"]["state"], reasonCode?: PublicationSubmissionRecord["result"]["reason_code"]): Promise<void> {
  const current = await readPublicationSubmission(env, intent.operation.job_id);
  if (!current || JSON.stringify(current.value.intent) !== JSON.stringify(intent)) throw new PublicationSubmissionConflict();
  const next = publicationSubmissionRecordSchema.parse({ ...current.value, result: {
    submission_id: intent.submission_id, intent_sha256: current.value.result.intent_sha256, state,
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  } });
  if (JSON.stringify(next) === JSON.stringify(current.value)) return;
  if (["completed", "failed", "rejected"].includes(current.value.result.state) ||
    current.value.result.state === "committed" && state === "pending") throw new PublicationSubmissionConflict();
  const written = await env.CASTLOOP_BUCKET.put(publicationSubmissionKey(intent.operation.job_id), JSON.stringify(next), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new PublicationSubmissionConflict();
}
