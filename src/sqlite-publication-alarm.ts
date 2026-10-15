import { sqlitePublicationFailureSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationFailure, SqlitePublicationRequest, SqlitePublicationStatus } from "../packages/shared/src/sqlite-publication";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";

export class SqlitePublicationInputError extends Error {
  readonly reason: SqlitePublicationFailure;
  constructor(reason: SqlitePublicationFailure) {
    const code = sqlitePublicationFailureSchema.parse(reason);
    super(code);
    this.reason = code;
  }
}

export type SqlitePublicationExecutor<Prepared> = {
  validate: (request: SqlitePublicationRequest) => Promise<Prepared>;
  publish: (prepared: Prepared) => Promise<void>;
};
export type SqlitePublicationEvent = { event: "sqlite_publication"; phase: "started" | "succeeded" | "failed" | "blocked";
  job_id: string; request_id: string; sequence: number; reason_code?: SqlitePublicationStatus["reason_code"] };
export type SqliteAlarmResult = { state: "idle" | "busy" } | SqlitePublicationStatus;

export class SqlitePublicationAlarm<Prepared> {
  private executing = false;
  constructor(private readonly queue: SqlitePublicationQueue, private readonly executor: SqlitePublicationExecutor<Prepared>,
    private readonly onEvent: (event: SqlitePublicationEvent) => void = (event) => {
      if (event.phase === "blocked") console.error(JSON.stringify(event));
      else console.log(JSON.stringify(event));
    }) {}

  private emit(job: SqlitePublicationStatus, phase: SqlitePublicationEvent["phase"]): void {
    this.onEvent({ event: "sqlite_publication", phase, job_id: job.job_id, request_id: job.request_id,
      sequence: job.sequence, ...(job.reason_code ? { reason_code: job.reason_code } : {}) });
  }

  async alarm(): Promise<SqliteAlarmResult> {
    if (this.executing) return { state: "busy" };
    this.executing = true;
    try {
      const claim = this.queue.claim();
      if (claim.state === "idle") return { state: "idle" };
      if (claim.state === "blocked") { this.emit(claim.job, "blocked"); return claim.job; }
      if (claim.state === "interrupted") {
        const job = await this.queue.block(claim.job.job_id, "execution_interrupted");
        this.emit(job, "blocked");
        return job;
      }
      await this.queue.confirm();
      this.emit(claim.job, "started");
      let prepared: Prepared;
      try { prepared = await this.executor.validate(claim.request); }
      catch (error) {
        const job = error instanceof SqlitePublicationInputError ? await this.queue.finish(claim.job.job_id, error.reason) :
          await this.queue.block(claim.job.job_id, "validation_unavailable");
        this.emit(job, job.state === "failed" ? "failed" : "blocked");
        return job;
      }
      try { await this.executor.publish(prepared); }
      catch {
        const job = await this.queue.block(claim.job.job_id, "execution_failed");
        this.emit(job, "blocked");
        return job;
      }
      const job = await this.queue.finish(claim.job.job_id);
      this.emit(job, "succeeded");
      return job;
    } finally { this.executing = false; }
  }
}
