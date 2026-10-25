import { z } from "zod";
import { sqlitePublicationStatusSchema } from "@castloop/shared";
import type { SqlitePublicationStatus, SqliteServiceConfig } from "@castloop/shared";
import { resolveSqliteJob } from "./job-lookup";
import { administratorKey } from "./administrator-key";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { requireSqliteStatus } from "./sqlite-draft-journal";
import type { R2RestTransport } from "./verified-r2-put";

export const WATCH_DEFAULT_TIMEOUT_SECONDS = 600;
export const WATCH_MAX_TIMEOUT_SECONDS = 3600;
export const WATCH_DEFAULT_INTERVAL_SECONDS = 5;
export const WATCH_MIN_INTERVAL_SECONDS = 1;
export const WATCH_MAX_INTERVAL_SECONDS = 60;
export const WATCH_MAX_POLLS = 720;

export const watchResultSchema = z.object({
  schema_version: z.literal(1),
  job_id: z.uuid(),
  show_id: z.string().max(32),
  episode_id: z.string().max(80).optional(),
  outcome: z.object({ state: z.enum(["succeeded", "failed", "blocked", "unobservable"]),
    reason_code: z.string().max(64).optional() }).strict(),
  status: sqlitePublicationStatusSchema.nullable(),
  observation: z.object({ polls: z.number().int().nonnegative(), gaps: z.number().int().nonnegative(),
    ever_observed: z.boolean(), last_observed_at: z.string().nullable(),
    budget: z.object({ timeout_seconds: z.number().int().positive(), interval_seconds: z.number().int().positive() }).strict() }).strict(),
  next_actions: z.array(z.object({ action: z.string().max(64), command: z.string().max(32).optional(),
    args: z.array(z.string().max(128)).max(4).optional() }).strict()).max(3),
  snapshot_only: z.literal(true),
}).strict();
export type WatchResult = z.infer<typeof watchResultSchema>;
export type WatchEvent = { event: "sqlite_watch"; job_id: string; state: string; sequence: number | null; poll: number; gap: boolean };

type WatchOptions = { timeoutSeconds?: number; intervalSeconds?: number; transport?: R2RestTransport; signal?: AbortSignal;
  now?: () => number; delay?: (milliseconds: number) => Promise<void>; onEvent?: (event: WatchEvent) => void };

export async function watchSqliteJob(root: string, config: SqliteServiceConfig, jobId: string,
  options: WatchOptions = {}): Promise<WatchResult> {
  const timeoutSeconds = options.timeoutSeconds ?? WATCH_DEFAULT_TIMEOUT_SECONDS;
  const intervalSeconds = options.intervalSeconds ?? WATCH_DEFAULT_INTERVAL_SECONDS;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > WATCH_MAX_TIMEOUT_SECONDS ||
    !Number.isSafeInteger(intervalSeconds) || intervalSeconds < WATCH_MIN_INTERVAL_SECONDS || intervalSeconds > WATCH_MAX_INTERVAL_SECONDS) {
    throw new RangeError(`--timeout must be 1..${WATCH_MAX_TIMEOUT_SECONDS} seconds and --interval ${WATCH_MIN_INTERVAL_SECONDS}..${WATCH_MAX_INTERVAL_SECONDS} seconds`);
  }
  const resolution = await resolveSqliteJob(root, config, jobId);
  if (!resolution) throw new Error("No matching SQLite job journal");
  const key = administratorKey(root);
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const emit = options.onEvent ?? ((event: WatchEvent) => console.error(JSON.stringify(event)));
  const budget = { timeout_seconds: timeoutSeconds, interval_seconds: intervalSeconds };
  if (resolution.source === "draft" || resolution.source === "revision" && !resolution.submitted) {
    return watchResultSchema.parse({ schema_version: 1, job_id: jobId, show_id: resolution.showId,
      ...(resolution.episodeId !== undefined ? { episode_id: resolution.episodeId } : {}),
      outcome: { state: "unobservable", reason_code: "job_not_submitted" }, status: null,
      observation: { polls: 0, gaps: 0, ever_observed: false, last_observed_at: null, budget },
      next_actions: [{ action: "observe_same_job", command: "progress", args: [jobId] }], snapshot_only: true });
  }
  const client = new SqlitePublicationClient(resolution.observationConfig, key, options.transport);
  const deadline = now() + timeoutSeconds * 1000;
  let polls = 0;
  let gaps = 0;
  let everObserved = false;
  let last: SqlitePublicationStatus | null = null;
  let lastObservedAt: string | null = null;
  let lastState: string | null = null;
  let outcome: WatchResult["outcome"] | null = null;
  while (outcome === null) {
    if (options.signal?.aborted) { outcome = { state: "unobservable", reason_code: "interrupted" }; break; }
    if (polls >= WATCH_MAX_POLLS || now() >= deadline) { outcome = { state: "unobservable", reason_code: "budget_exhausted" }; break; }
    polls += 1;
    try {
      const status = await client.observe(resolution.request);
      if (status === null) {
        if (everObserved || resolution.source === "revision" && resolution.status) { outcome = { state: "unobservable", reason_code: "job_missing" }; break; }
        emit({ event: "sqlite_watch", job_id: jobId, state: "not_visible", sequence: null, poll: polls, gap: false });
        lastState = "not_visible";
      } else {
        if (resolution.source === "revision") requireSqliteStatus(resolution.request, resolution.requestSha256, status, last ?? resolution.status ?? undefined);
        everObserved = true;
        last = status;
        lastObservedAt = new Date(now()).toISOString();
        if (status.state !== lastState) {
          emit({ event: "sqlite_watch", job_id: jobId, state: status.state, sequence: status.sequence, poll: polls, gap: false });
          lastState = status.state;
        }
        if (status.state === "succeeded" || status.state === "failed" || status.state === "blocked") {
          outcome = { state: status.state, ...(status.reason_code ? { reason_code: status.reason_code } : {}) };
          break;
        }
      }
    } catch {
      gaps += 1;
      emit({ event: "sqlite_watch", job_id: jobId, state: lastState ?? "unknown", sequence: last?.sequence ?? null, poll: polls, gap: true });
    }
    if (outcome === null) {
      const remaining = deadline - now();
      if (remaining <= 0) { outcome = { state: "unobservable", reason_code: "budget_exhausted" }; break; }
      await delay(Math.min(intervalSeconds * 1000, remaining));
    }
  }
  const nextActions = outcome.state === "succeeded"
    ? [{ action: "verify_delivery", command: "verify", args: [resolution.showId] }]
    : outcome.state === "unobservable"
      ? [{ action: "observe_same_job", command: "progress", args: [jobId] }]
      : [{ action: "preserve_records_and_inspect" }, { action: "observe_same_job", command: "progress", args: [jobId] }];
  return watchResultSchema.parse({ schema_version: 1, job_id: jobId, show_id: resolution.showId,
    ...(resolution.episodeId !== undefined ? { episode_id: resolution.episodeId } : {}),
    outcome, status: last, observation: { polls, gaps, ever_observed: everObserved, last_observed_at: lastObservedAt,
      budget },
    next_actions: nextActions, snapshot_only: true });
}

export function watchExitCode(result: WatchResult): number {
  if (result.outcome.state === "succeeded") return 0;
  if (result.outcome.state === "unobservable") return 2;
  return 1;
}

export function formatWatch(result: WatchResult): string {
  const lines = [`Watch ${result.job_id} (${result.show_id}${result.episode_id === undefined ? "" : `/${result.episode_id}`}): ${result.outcome.state}${result.outcome.reason_code ? ` (${result.outcome.reason_code})` : ""}`];
  if (result.status) lines.push(`Last status: ${result.status.state} (sequence ${result.status.sequence}${result.status.reason_code ? `, ${result.status.reason_code}` : ""})`);
  lines.push(`Observation: ${result.observation.polls} poll(s), ${result.observation.gaps} gap(s), ever observed: ${result.observation.ever_observed}`);
  for (const action of result.next_actions) {
    lines.push(`Next: ${action.action}${action.command ? ` — castloop ${action.command} ${(action.args ?? []).join(" ")}`.trimEnd() : ""}`);
  }
  return lines.join("\n");
}
