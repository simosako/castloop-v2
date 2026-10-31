# Updating actions used by release CI

The [build workflow](../../.github/workflows/build-binaries.yml) pins external actions to 40-character commit SHAs. Check the official releases before updating these pins.

## 1. Review the update

Read the release and security information in each action's official repository. If the runtime, required permissions, or download sources change, review their impact.

Find the commit SHA referenced by the release tag you intend to use. For an annotated tag, follow the tag to its commit.

## 2. Update the workflow

Update the SHA and adjacent version comment in every step that uses the action. Write comments in English.

Keep the existing permission separation: ordinary jobs use `contents: read`, and the release job that publishes from a tag uses `contents: write`.

## 3. Verify and merge

```sh
bun test
npm run check
```

After the local checks, create a PR and verify the build and smoke jobs on each operating system. If you also change a major version or runtime environment, describe those changes in the PR.

For details, see GitHub's [security guide for GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use).
