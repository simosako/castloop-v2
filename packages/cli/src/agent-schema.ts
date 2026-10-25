import { z } from "zod";
import { episodeDraftInputSchema, showMetadataInputSchema } from "@castloop/shared";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import { adminConfigSchema } from "../../shared/src/admin-config";
import * as limits from "../../shared/src/metadata-limits";

export const CONTRACT_VERSION = 1;
export const INPUT_SCHEMAS = {
  "service-config": sqliteServiceConfigSchema,
  "admin-config": adminConfigSchema,
  "show-input": showMetadataInputSchema,
  "episode-input": episodeDraftInputSchema,
};
export const resultEnvelopeSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSION), command: z.string(), ok: z.boolean(),
  target: z.object({ workspace: z.string().optional(), show_id: z.string().optional() }).strict(),
  result: z.json().nullable(),
  operation: z.object({ kind: z.string(), job_id: z.string().optional(), state: z.string().optional() }).strict().nullable(),
  error: z.object({ code: z.string(), message: z.string(), outcome: z.enum(["not_started", "unknown"]),
    fields: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), code: z.string() }).strict()).optional() }).strict().nullable(),
  next_actions: z.array(z.object({ action: z.string(), command: z.string().optional(), args: z.array(z.string()).optional() }).strict()),
}).strict();

export function inputSchema(name: string): object {
  if (name === "result") return z.toJSONSchema(resultEnvelopeSchema);
  if (!Object.hasOwn(INPUT_SCHEMAS, name)) throw new Error("Unknown input schema");
  const schema = INPUT_SCHEMAS[name as keyof typeof INPUT_SCHEMAS];
  const constraints = name === "show-input" ? {
    title: [limits.SHOW_TITLE_MAX_CHARS, "code_points"], description: [limits.SHOW_DESCRIPTION_MAX_BYTES, "utf8_bytes"],
    author: [limits.SHOW_AUTHOR_MAX_CHARS, "code_points"], owner_name: [limits.SHOW_OWNER_NAME_MAX_CHARS, "code_points"],
    owner_email: [limits.SHOW_OWNER_EMAIL_MAX_CHARS, "code_points"], categories: [limits.SHOW_CATEGORY_MAX_CHARS, "code_points_per_item"],
    copyright: [limits.SHOW_COPYRIGHT_MAX_CHARS, "code_points"], site_url: [limits.SHOW_SITE_URL_MAX_CHARS, "code_points_without_html_removal"],
  } : name === "episode-input" ? {
    title: [limits.EPISODE_TITLE_MAX_CHARS, "code_points"], description: [limits.EPISODE_DESCRIPTION_MAX_CHARS, "code_points"],
    guid: [4096, "utf8_bytes_without_html_removal"],
  } : {};
  return { ...z.toJSONSchema(schema, { io: "input" }), $id: `urn:castloop:${name}:1`,
    "x-castloop-contract-version": CONTRACT_VERSION,
    "x-castloop-validation": { command: "validate", required: true,
       toml: "Dates must be quoted RFC 3339 strings. Unknown keys and null are rejected.",
       ...(name === "show-input" ? { website: "site_mode=builtin forbids site_url; external or omitted site_mode requires site_url. Publication generates builtin HTML; staging alone does not." } : {}),
      additional_checks: name === "admin-config" ? ["Supported IANA time zone name or UTC; abbreviations are rejected"] :
        ["XML 1.0 text", "real calendar dates", "HTTP(S) URLs without credentials or fragment", "cross-field constraints"],
      measured_limits: constraints, measurement: "Trim, strip HTML tags, trim; count Unicode code points or UTF-8 bytes as specified. GUID and URL do not strip HTML.",
      identity: name === "episode-input" ? ["episode_id", "guid", "guid_is_permalink", "published_at"] : [],
      generated_values: name === "admin-config" ? "Optional CLI preferences only; no credentials, targets, approvals or remote identity." :
        name === "episode-input" ? "Preserve GUID and date saved by create-episode; examples are not identities." : "Service resource identifiers come from init; never adopt resources from examples." } };
}
