import { z } from "zod";
import { CONTRACT_VERSION } from "./agent-schema";

export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly fields?: { path: (string | number)[]; code: string }[]) { super(message); }
}

export function agentEnvelope(command: string, target: { workspace?: string; show_id?: string }, result: unknown,
  error?: unknown, mutationStarted = false) {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const nestedOperation = value.operation && typeof value.operation === "object" ? value.operation as Record<string, unknown> : {};
  const state = typeof value.state === "string" ? value.state : typeof value.phase === "string" ? value.phase : undefined;
  const operationId = typeof value.operation_id === "string" ? value.operation_id : undefined;
  const contentPublication = ["publish-show", "publish-episode", "lifecycle-execute", "revision-execute"].includes(command);
  const kind = typeof nestedOperation.kind === "string" ? nestedOperation.kind : command;
  const providedNextActions = Array.isArray(value.next_actions)
    ? value.next_actions.filter((entry): entry is { action: string; command?: string; args?: string[] } =>
      typeof entry === "object" && entry !== null && typeof (entry as { action?: unknown }).action === "string")
    : undefined;
  return { contract_version: CONTRACT_VERSION, command, ok: error === undefined, target, result: result ?? null,
    operation: operationId || Object.keys(nestedOperation).length ? { kind, ...(state ? { state } : {}) } : null,
    error: error === undefined ? null : { code: error instanceof AgentError ? error.code : error instanceof z.ZodError ? "invalid_input" : "command_failed",
      message: error instanceof AgentError ? error.message : contentPublication ? "Publication was not confirmed; inspect current content before rerunning the same approved inputs." :
        "Command failed; preserve local records and inspect the same operation. Do not replay mutations.",
      outcome: mutationStarted ? "unknown" : "not_started",
      ...(error instanceof AgentError && error.fields ? { fields: error.fields } : {}) },
    next_actions: error !== undefined ? [{ action: mutationStarted ? "preserve_records_and_inspect" : "correct_inputs_or_inspect" },
      ...(command === "domain" && operationId ? [{ action: "observe_same_operation", command: "domain", args: ["status", operationId, ...(target.workspace ? ["--workspace", target.workspace] : [])] }] : [])] :
      providedNextActions ?? (state === "blocked" ? [{ action: "stop_and_preserve_records" }] : []) };
}
