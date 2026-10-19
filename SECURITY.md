# Security Policy

## Supported versions

Only the **latest published release** receives security fixes. There are no long-term support branches. If you run an older release, upgrade to the latest one; note that schema-version-1 (Queue) services require the separate v0.5.x CLI and Worker, which are maintained on their own branch and only receive fixes at the maintainer's discretion.

## Reporting a vulnerability

Please report security problems **privately** using GitHub's [private vulnerability reporting](https://github.com/simosako/castloop-v2/security/advisories/new) (Security tab → "Report a vulnerability"). Do **not** open a public issue for anything you believe is exploitable.

When reporting:

- Describe the affected command, code path and release (run `castloop --version`).
- Include a minimal, redacted reproduction. Do **not** include:
  - `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` values,
  - the service administrator key,
  - any file or journal content from `.castloop/`,
  - unpublished audio, private staging URLs, or your workers.dev subdomain if it is not already public.

Reports that expose credentials or private content cannot be accepted as-is; redact first, then submit.

## Scope

In scope:

- The castloop CLI source (`packages/`), the embedded Worker source (`src/sqlite-worker.ts`), the build scripts, and the published binary artifacts.
- Behavior that leaks, corrupts or allows unauthorized access to service data, bypasses the administrator-key checks, or weakens the publication/lifecycle gates described in the documentation.

Out of scope:

- Vulnerabilities in the Cloudflare platform itself (Workers, R2, Durable Objects). Report those to [Cloudflare](https://www.cloudflare.com/disclosure/).
- Use of castloop with stolen, leaked or overly broad credentials of your own, and cost overruns caused by your Cloudflare usage. castloop never expands token permissions or changes billing/CPU limits automatically, but it does deploy into **your** account; treat the tokens you give it accordingly.

## Handling

- The maintainer responds on a best-effort basis; there is no guaranteed response time.
- Confirmed issues are fixed in the next release, and the reporter is credited in the release notes unless they prefer otherwise.
- Until a fix is published, the usual mitigations apply: keep `CLOUDFLARE_API_TOKEN` scoped to the permissions the README documents, keep `.castloop/` private, and pause the service (`castloop service-pause`) if you suspect active abuse.
