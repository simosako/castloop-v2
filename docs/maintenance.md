# Service maintenance

This guide explains how to update the delivery server (Worker) of an existing service using the version bundled with a new CLI.

## 1. Prepare for the update

1. Check the [release notes](https://github.com/simosako/castloop-v2/releases) to make sure your service can be updated to the new version.
2. [Update the CLI](installation.md#update-the-cli).
3. Create a [backup](workspace_backup.md) of the original workspace.
4. Set the Cloudflare account ID and API token as [environment variables](getting_started.md#1-set-cloudflare-credentials).

## 2. Update the server

Check the current status, then run `deploy`:

```sh
castloop service-status --workspace /path/to/workspace --json
castloop deploy --workspace /path/to/workspace --json
```

Published content, audio, images, history, schedules, and custom domains are preserved.

## 3. Check the result

```sh
castloop service-status --workspace /path/to/workspace --json
castloop verify my-show --workspace /path/to/workspace --json
```

Check that `publication_ready` is `true`, and check the display and audio on the show website.

## If an update is interrupted

Make sure the command has finished and check the current status with `service-status`. Then run `deploy` again using the same workspace and configuration.

For compatibility or configuration errors, check the release notes and the error message. See [Troubleshooting](troubleshooting.md) for other status checks.
