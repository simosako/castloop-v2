---
name: Castloop Release
description: Use when preparing or publishing a castloop CLI release, including version updates, release notes, release PRs, tags, and GitHub Release verification.
---

# Castloop Release

## Start with the release procedure

Read the English [release procedure](../../../docs/development/releasing.md) before acting. It owns the scope definitions, required checks, release-note requirements, operations and completion criteria.

Identify whether the request is preparation-only or includes publication. Preparation ends at the PR and required CI confirmation; publication continues through GitHub Release verification. Resolve an unclear version or a consequential scope ambiguity before acting.

## Carry out the requested scope

Follow the procedure through the requested stopping point. Use its verification policy and release-note requirements rather than maintaining a second checklist here.

A CLI release distributes the embedded Worker; it does not authorize deployment to a live Cloudflare account. Live trials require the `castloop-live-trial` skill and explicit authorization for their targets and operations.

## Verify completion

Verify the procedure's completion criteria for the requested scope and report the resulting PR or release with the checks actually completed. If a criterion is unmet, report it as incomplete.
