import { z } from "zod";

// Retained only for inspecting historical trial evidence, not current publication.
export const sqlitePublicationStatusSchema = z.object({ protocol: z.literal("sqlite-sequential-v1"),
  service_id: z.string().max(20).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), request_id: z.uuid(), job_id: z.uuid(),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["queued", "running", "succeeded", "failed", "blocked"]),
  reason_code: z.enum(["validation_failed", "base_conflict", "target_unavailable", "stale_window", "runtime_mismatch",
    "execution_interrupted", "validation_unavailable", "execution_failed", "stored_request_invalid"]).optional(),
}).strict().superRefine((value, context) => {
  const failures = ["validation_failed", "base_conflict", "target_unavailable", "stale_window", "runtime_mismatch"];
  const blocks = ["execution_interrupted", "validation_unavailable", "execution_failed", "stored_request_invalid"];
  if (value.state === "failed" ? !failures.includes(value.reason_code ?? "") :
    value.state === "blocked" ? !blocks.includes(value.reason_code ?? "") : value.reason_code !== undefined) {
    context.addIssue({ code: "custom", message: "Publication state and reason code differ" });
  }
});
