import { sqlitePublicationFailureSchema, sqlitePublicationRequestHash } from "../packages/shared/src/sqlite-publication";
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
  publish: (prepared: Prepared) => Promise<void | false>;
  commit?: (prepared: Prepared) => undefined;
};
export type SqlitePublicationEvent = { event: "sqlite_publication"; phase: "started" | "succeeded" | "failed" | "blocked";
  job_id: string; request_id: string; sequence: number; invocation_id: string; reason_code?: SqlitePublicationStatus["reason_code"] };
export type SqliteAlarmResult = { state: "idle" | "busy" } | SqlitePublicationStatus;

export class SqlitePublicationAlarm<Prepared> {
  private executing = false;
  constructor(private readonly queue: SqlitePublicationQueue, private readonly executor: SqlitePublicationExecutor<Prepared>,
    private readonly onEvent: (event: SqlitePublicationEvent) => void = (event) => {
      if (event.phase === "blocked") console.error(JSON.stringify(event));
      else console.log(JSON.stringify(event));
    }) {}

  private emit(job: SqlitePublicationStatus, phase: SqlitePublicationEvent["phase"], invocation: string): void {
    this.onEvent({ event: "sqlite_publication", phase, job_id: job.job_id, request_id: job.request_id,
      sequence: job.sequence, invocation_id: invocation, ...(job.reason_code ? { reason_code: job.reason_code } : {}) });
  }

  async alarm(): Promise<SqliteAlarmResult> {
    if (this.executing) return { state: "busy" };
    this.executing = true;
    const invocation = crypto.randomUUID();
    try {
      const claim = this.queue.claim(invocation);
      if (claim.state === "idle") return { state: "idle" };
      if (claim.state === "blocked") { this.emit(claim.job, "blocked", invocation); return claim.job; }
      if (claim.state === "interrupted") {
        const job = await this.queue.block(claim.job.job_id, "execution_interrupted", invocation);
        this.emit(job, "blocked", invocation);
        return job;
      }
      await this.queue.confirm();
      if (await sqlitePublicationRequestHash(claim.request) !== claim.job.request_sha256) {
        const job = await this.queue.block(claim.job.job_id, "stored_request_invalid", invocation);
        this.emit(job, "blocked", invocation);
        return job;
      }
      this.emit(claim.job, "started", invocation);
      let prepared: Prepared;
      try { prepared = await this.executor.validate(claim.request); }
      catch (error) {
        const job = error instanceof SqlitePublicationInputError ? await this.queue.finish(claim.job.job_id, error.reason, undefined, invocation) :
          await this.queue.block(claim.job.job_id, "validation_unavailable", invocation);
        this.emit(job, job.state === "failed" ? "failed" : "blocked", invocation);
        return job;
      }
      try { if (await this.executor.publish(prepared) === false) return await this.queue.yield(claim.job.job_id); }
      catch {
        const job = await this.queue.block(claim.job.job_id, "execution_failed", invocation);
        this.emit(job, "blocked", invocation);
        return job;
      }
      const job = await this.queue.finish(claim.job.job_id, undefined, () => this.executor.commit?.(prepared), invocation);
      this.emit(job, "succeeded", invocation);
      return job;
    } finally { this.executing = false; }
  }
}
