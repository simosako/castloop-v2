import { z } from "zod";

export const diagnosticScopeSchema = z.enum(["local", "remote", "external", "cross"]);
export const diagnosticStatusSchema = z.enum(["pass", "warn", "fail", "not_checked"]);
export const diagnosticCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  scope: diagnosticScopeSchema,
  status: diagnosticStatusSchema,
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  message: z.string().min(1).max(400),
  next_actions: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/).max(64)).max(4),
}).strict();
export const diagnosticSummarySchema = z.object({
  pass: z.number().int().nonnegative(),
  warn: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  not_checked: z.number().int().nonnegative(),
}).strict();

export type DiagnosticScope = z.infer<typeof diagnosticScopeSchema>;
export type DiagnosticStatus = z.infer<typeof diagnosticStatusSchema>;
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;
export type DiagnosticSummary = z.infer<typeof diagnosticSummarySchema>;
