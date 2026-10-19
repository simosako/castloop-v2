## Summary

<!-- What does this PR change and why? Link the related issue with "Fixes #NN" when applicable. -->

## Changes

<!-- Bullet list of the concrete changes. -->

## Tests

- [ ] `npm run check` passes
- [ ] `bun test` passes (tests stay local; no Cloudflare credentials or live resources involved)

## Documentation

- [ ] Relevant `docs/` / `design/` documents updated when behavior changed (not applicable for pure refactors)
- [ ] `THIRD_PARTY_NOTICES.md` updated if dependencies changed

## Safety

- [ ] No credentials, `.castloop/` content, journals, or unpublished audio included in the diff
- [ ] Safety gates preserved: explicit publication, `failed`/`blocked` distinction, no automatic POST/PUT retry, immutable published audio, allowlisted worker diagnostics
- [ ] No new lint/format tooling added
