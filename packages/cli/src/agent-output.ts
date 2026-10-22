import { z } from "zod";
import { CONTRACT_VERSION } from "./agent-schema";

export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly fields?: { path: (string | number)[]; code: string }[]) { super(message); }
}

export function agentEnvelope(command: string, target: { workspace?: string; show_id?: string }, result: unknown,
  error?: unknown, mutationStarted = false) {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const job = typeof value.job_id === "string" ? value.job_id : undefined;
  const nestedStatus = value.status && typeof value.status === "object" ? value.status as Record<string, unknown> : {};
  const nestedOperation = value.operation && typeof value.operation === "object" ? value.operation as Record<string, unknown> : {};
  const state = typeof value.state === "string" ? value.state : typeof nestedStatus.state === "string" ? nestedStatus.state : undefined;
  const kind = command.startsWith("publish-") ? "publication" : command === "job-status" ? "publication_or_lifecycle" :
    typeof nestedOperation.kind === "string" ? nestedOperation.kind :
    ["update-show", "update-episode", "update-episode-audio"].includes(command) ? "upload" : command;
  return { contract_version: CONTRACT_VERSION, command, ok: error === undefined, target, result: result ?? null,
    operation: job || Object.keys(nestedOperation).length ? { kind, ...(job ? { job_id: job } : {}), ...(state ? { state } : {}) } : null,
    error: error === undefined ? null : { code: error instanceof AgentError ? error.code : error instanceof z.ZodError ? "invalid_input" : "command_failed",
      message: error instanceof AgentError ? error.message : "Command failed; preserve local records and inspect the same operation. Do not replay mutations.",
      outcome: mutationStarted ? "unknown" : "not_started",
      ...(error instanceof AgentError && error.fields ? { fields: error.fields } : {}) },
    next_actions: error !== undefined ? [{ action: mutationStarted ? "preserve_records_and_inspect" : "correct_inputs_or_inspect" },
      ...(job ? [{ action: "observe_same_job", command: "job-status", args: [job, ...(target.workspace ? ["--workspace", target.workspace] : [])] }] : [])] :
      job && ["queued", "running"].includes(state ?? "") ? [{ action: "observe_same_job", command: "job-status", args: [job] }] :
      state === "blocked" ? [{ action: "stop_and_preserve_records" }] : [] };
}
