import { parseStageReadbackReceipts, verifyManagementResult } from "@castloop/shared";
import type { ManagementResult, StageReadbackReceipt } from "@castloop/shared";
import type { ManagementQueueTransport } from "./management-queue-client";
import type { PublicationJournal } from "./publication-journal";
import { stagingClientOperation, stagingClientTargets } from "./staging-client";
import type { StagePutTarget } from "./staging-client";
import type { StagingJournal } from "./staging-journal";

function requireResult(result: ManagementResult, state: ManagementResult["state"]): void {
  if (result.state !== state) throw new Error(`Management request stopped [state=${result.state}, reason_code=${result.reason_code ?? "unconfirmed"}]; preserve its frozen journal and any owner without replay`);
}

export async function runAsyncDraftUpload(journal: StagingJournal, transport: ManagementQueueTransport, adminKey: string,
  put: (target: StagePutTarget, index: number) => Promise<StageReadbackReceipt>, checkLocalInputs: () => Promise<void>): Promise<void> {
  await journal.exclusively(async () => {
    let state = journal.load();
    if (state.phase !== "prepared") throw new Error("Do not replay an attempted async upload or reopen PUT permission");
    await checkLocalInputs();
    const start = await transport.prepare({ action: "stage-start", upload: state.upload });
    await checkLocalInputs();
    journal.save({ ...state, phase: "claim_requested", async_start: start });
    state = journal.load();
    await transport.send(start);
    journal.save({ ...state, start_queued: true });
    state = journal.load();
    const grant = await verifyManagementResult(await transport.wait(start), start.intent, adminKey);
    requireResult(grant, "granted");
    if (JSON.stringify(grant.payloads) !== JSON.stringify(stagingClientTargets(state.upload))) throw new Error("Upload grant differs from the frozen exact keys, sizes and checksums");
    await checkLocalInputs();
    journal.save({ ...state, phase: "claimed", claim_receipt: stagingClientOperation(state.upload), grant_result: grant });
    state = journal.load();
    journal.save({ ...state, phase: "begin_requested" });
    journal.save({ ...journal.load(), phase: "begin_acknowledged", begin_receipt: grant.payloads });
    journal.save({ ...journal.load(), phase: "puts_running" });
    const receipts: StageReadbackReceipt[] = [];
    let failed = false;
    try {
      for (const target of grant.payloads!) {
        const receipt = await put(target, receipts.length);
        parseStageReadbackReceipts(state.upload, [...receipts, receipt]);
        receipts.push(receipt);
      }
    } catch { failed = true; }
    const outcome = failed ? "aborted" : "staged";
    journal.save({ ...journal.load(), phase: "puts_settled", put_outcome: outcome, acknowledged_puts: receipts.length,
      readback_receipts: receipts, ...(failed ? { reason_code: "put_failed" as const } : {}) });
    const complete = await transport.prepare({ action: "upload-complete", upload: state.upload,
      grant_request_id: start.intent.request_id, settlement: { put_requests_settled: true, no_more_puts: true, readback_receipts: receipts }, outcome }, start);
    journal.save({ ...journal.load(), phase: "settlement_requested", async_complete: complete });
    await transport.send(complete);
    journal.save({ ...journal.load(), complete_queued: true });
    const result = await verifyManagementResult(await transport.wait(complete), complete.intent, adminKey);
    requireResult(result, outcome);
    journal.save({ ...journal.load(), phase: "settled", complete_result: result });
    journal.save({ ...journal.load(), phase: "finish_requested" });
    journal.save({ ...journal.load(), phase: "finished", finish_receipt: outcome });
  });
}

export async function runAsyncDraftPublication(journal: PublicationJournal, transport: ManagementQueueTransport,
  checkLocalInputs: () => Promise<void>): Promise<void> {
  await journal.exclusively(async () => {
    const state = journal.load();
    if (state.phase !== "prepared") throw new Error("Do not replay an attempted async publication");
    await checkLocalInputs();
    const submission = await transport.prepare({ action: "publish", publication: state.publication });
    await checkLocalInputs();
    journal.save({ ...state, phase: "async_submit_requested", async_submission: submission });
    await transport.send(submission);
    journal.save({ ...journal.load(), phase: "async_queued" });
  });
}
