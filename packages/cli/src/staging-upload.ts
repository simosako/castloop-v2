import { parseStageReadbackReceipts, stagePayloadKey, stageUploadRequestSchema } from "../../shared/src/index";
import type { StageReadbackReceipt, StageSettlement, StageUploadRequest } from "../../shared/src/index";

export type StageClientOperation = { showId: string; operationId: string; generation: number };
export type StageClientEffects = {
  claim: (request: StageUploadRequest) => Promise<StageClientOperation>;
  begin: (operation: StageClientOperation) => Promise<Array<{ key: string; length: number; sha256: string }>>;
  put: (target: { key: string; length: number; sha256: string }, index: number) => Promise<StageReadbackReceipt>;
  settle: (operation: StageClientOperation, evidence: StageSettlement) => Promise<void>;
  finish: (operation: StageClientOperation, outcome: "staged" | "aborted") => Promise<void>;
};

export async function runStageClientUpload(input: StageUploadRequest, effects: StageClientEffects): Promise<void> {
  const request = stageUploadRequestSchema.parse(input);
  const operation = await effects.claim(request);
  if (operation.operationId !== request.operation_id || operation.showId !== request.show_id ||
    operation.generation !== request.expected_show_generation + 1) throw new Error("Staging admission does not match its frozen request");
  const targets = await effects.begin(operation);
  let failure: unknown;
  let failed = false;
  const readbacks: StageReadbackReceipt[] = [];
  try {
    if (targets.length !== request.payloads.length) throw new Error("Staging upload permission does not match its frozen payloads");
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      const payload = request.payloads[index]!;
      if (target.key !== stagePayloadKey(request, payload.asset) || target.length !== payload.length_bytes || target.sha256 !== payload.sha256) {
        throw new Error("Staging upload permission does not match its payload key, checksum and size");
      }
      const proof = await effects.put(target, index);
      parseStageReadbackReceipts(request, [...readbacks, proof]);
      readbacks.push(proof);
    }
  } catch (error) { failed = true; failure = error; }
  await effects.settle(operation, { put_requests_settled: true, no_more_puts: true, readback_receipts: readbacks });
  await effects.finish(operation, failed ? "aborted" : "staged");
  if (failed) throw failure;
}
