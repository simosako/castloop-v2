import { describe, expect, test } from "bun:test";
import { stageUploadRequestSchema } from "../../shared/src/index";
import { runStageClientUpload } from "./staging-upload";
import type { StageClientEffects } from "./staging-upload";

function fixture() {
  const request = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    kind: "episode", show_id: "daily", episode_id: "first", expected_show_generation: 0, expected_episode_generation: 0,
    created_at: "2026-10-01T12:00:00Z", payloads: [{ asset: "audio", length_bytes: 1, sha256: "a".repeat(64) }] });
  const calls: string[] = [];
  const operation = { showId: "daily", operationId: request.operation_id, generation: 1 };
  const proof = { ...request.payloads[0]!, etag: "saved-etag", version: "saved-version" };
  const effects: StageClientEffects = {
    async claim() { calls.push("claim"); return operation; },
    async begin() { calls.push("begin"); return [{ key: `staging/episodes/daily/first/${request.draft_job_id}/audio.mp3`, length: 1, sha256: "a".repeat(64) }]; },
    async put() { calls.push("put"); return proof; },
    async settle(_operation, evidence) { calls.push("settle"); expect(evidence.put_requests_settled).toBe(true); expect(evidence.no_more_puts).toBe(true); },
    async finish(_operation, outcome) { calls.push(outcome); },
  };
  return { request, calls, effects, proof };
}

describe("M6 standalone CLI staging sequencing", () => {
  test("successful single PUT settles before verification and admission completion", async () => {
    const setup = fixture();
    await runStageClientUpload(setup.request, { ...setup.effects, async settle(operation, evidence) {
      expect(evidence.readback_receipts).toEqual([setup.proof]);
      await setup.effects.settle(operation, evidence);
    } });
    expect(setup.calls).toEqual(["claim", "begin", "put", "settle", "staged"]);
  });

  test("a live PUT is never settled or aborted before its promise ends", async () => {
    const setup = fixture();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const outcome = (async () => {
      try {
        await runStageClientUpload(setup.request, { ...setup.effects, async put() { setup.calls.push("put"); started.resolve(); await ended.promise; throw new Error("PUT interrupted"); } });
        return null;
      } catch (error) { return error; }
    })();
    await started.promise;
    expect(setup.calls).toEqual(["claim", "begin", "put"]);
    ended.resolve();
    expect((await outcome as Error).message).toBe("PUT interrupted");
    expect(setup.calls).toEqual(["claim", "begin", "put", "settle", "aborted"]);
  });

  test("unknown begin outcome never triggers automatic settlement or abort", async () => {
    const setup = fixture();
    await expect(runStageClientUpload(setup.request, { ...setup.effects, async begin() { throw new Error("Begin response lost"); } })).rejects.toThrow("response lost");
    expect(setup.calls).toEqual(["claim"]);
  });

  test("settlement failure leaves finalization uncalled and uploaded payloads recoverable", async () => {
    const setup = fixture();
    await expect(runStageClientUpload(setup.request, { ...setup.effects, async settle() { throw new Error("Settlement unavailable"); } })).rejects.toThrow("Settlement unavailable");
    expect(setup.calls).toEqual(["claim", "begin", "put"]);
  });
});
