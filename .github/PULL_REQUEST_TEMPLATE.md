## Summary

<!-- What does this PR change and why? Link the related issue with "Fixes #NN" when applicable. -->

## Changes

<!-- Bullet list of the concrete changes. -->

## Tests

- [ ] `npm run check` and `bun test` pass, or the reason they were not run is explained (for example, documentation-only changes)
- [ ] Automated tests stay local; no Cloudflare credentials or live resources are required

## Documentation

- [ ] Relevant `docs/` / `design/` documents updated when behavior changed (not applicable for pure refactors)
- [ ] `THIRD_PARTY_NOTICES.md` updated if dependency notices changed

## Safety

- [ ] No credentials, `.castloop/` content, journals, or unpublished audio included in the diff
- [ ] Safety gates preserved: explicit publication, atomic updates, reviewed inputs and delivery readiness, immutable published audio and history, no automatic retry of mutating requests, and allowlisted Worker diagnostics
- [ ] No new lint/format tooling added
