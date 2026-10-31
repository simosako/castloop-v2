# Status checks and troubleshooting

If a command fails or a publication result is unclear, check the local configuration, server, and public URLs in that order.

The examples use `/path/to/workspace` as the workspace and `my-show` as the show ID.

## 1. Check local configuration

```sh
castloop doctor --local --workspace /path/to/workspace --json
```

Review the results for configuration files and administrator keys. For any reported problem, check the relevant path or configuration.

## 2. Check service and show status

```sh
castloop service-status --workspace /path/to/workspace --json
castloop show-status my-show --workspace /path/to/workspace --json
```

Check that the service and show are correct and that `publication_ready` is `true`.

## diagnose

To run a combined diagnosis:

```sh
castloop diagnose my-show --workspace /path/to/workspace --json
```

This checks configuration, credentials, Cloudflare connectivity, and show registration and publication. Add `--external` to check public URLs too.

For each item, `pass` means the check passed, `warn` indicates a warning, `fail` indicates failure, and `not_checked` means it was not checked. Read the descriptions of failed checks and address them.

## verify

To verify delivery after publication:

```sh
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

This compares server content with delivery of the public RSS feed, cover, and specified audio. To check the RSS feed and cover alone, omit `--episode first`.

If access protection is enabled, also check in a browser using an authorized account.

## When an operation is interrupted

Make sure the command has finished. Keep the workspace, input files, assets, and `.castloop/`, then follow the appropriate row:

| Interrupted operation | How to check and continue |
| --- | --- |
| Publication or update | Check current content using the preview and history, then rerun with the same reviewed inputs. If the base revision has changed, review the differences again. |
| Unpublishing or restoring a revision | Check the current state and execute the saved plan. If the plan is stale, create and review a new one. |
| Creating a schedule | Check `schedule-list` and `schedule-status` to see whether it was accepted, then choose the appropriate operation. |
| Initialization | Run `castloop init /path/to/workspace` at the original destination and continue with the saved inputs. |
| Creating a show | Rerun `create-show` in the original workspace with the same show ID and settings. |
| Server update | Check the current state and rerun `deploy` with the same settings. See [Service maintenance](maintenance.md). |
| Custom domain change | [Check and continue using the operation ID](custom_domains.md#checking-and-continuing-an-interrupted-operation). |
| RSS import | [Continue with the same destination and inputs](rss_migration.md#if-the-operation-stops). |

A publication result of `unchanged` means the same content is already applied. A scheduled publication is complete when `schedule-status` reports `dispatched` and displays a `revision_id`.

## Errors at a public URL

| Result | What to check |
| --- | --- |
| 404 | Check the URL and whether the show or episode is published. To republish, see [Restoring content](lifecycle.md). |
| 503 | Check `service-status` and the status of any domain change in progress. |
| Authentication screen or access denied | Check the URLs covered by access protection and the authorized account. |
| Unclear whether changes were applied | Preview the current server content and compare it with public URLs using `verify`. |

## Before asking for help

Collect the CLI version, command, error code, and any failed diagnostic checks. Keep API tokens, administrator keys, `.castloop/` contents, unpublished text, and personal contact information private when sharing details.
