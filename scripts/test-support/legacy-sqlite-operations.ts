import { z } from "zod";

// Historical trial log vocabulary; no operation API or persistence remains.
export const operationStateSchema = z.enum(["prepared", "in_progress", "succeeded", "failed", "blocked", "cancelled"]);
export const operationPhaseSchema = z.enum(["prepared", "put_requested", "put_acknowledged", "verified", "attached",
  "queued", "running", "completed", "cancelled", "cleanup_requested", "cleanup_unknown", "command_requested", "step_completed"]);
export const operationReasonSchema = z.enum(["version_conflict", "target_conflict", "state_conflict", "asset_conflict",
  "capacity_insufficient", "execution_interrupted", "validation_unavailable", "execution_failed", "stored_request_invalid",
  "validation_failed", "base_conflict", "target_unavailable", "stale_window", "runtime_mismatch", "deletion_unverified"]);
