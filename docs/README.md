# castloop User Guide

castloop is a tool for hosting podcasts on Cloudflare. Use the command line to publish shows and episodes and manage your RSS feed and show website.

## Getting started

1. [Install the CLI](installation.md).
2. [Create a service and publish your first episode](getting_started.md).
3. [Update published content](publishing.md).

To move an existing podcast, create a service first, then follow [Importing and migrating an RSS feed](rss_migration.md).

## Find a guide

| Task | Guide |
| --- | --- |
| Review changes or RSS before publishing, or restore an earlier version | [Reviewing published content and restoring revisions](published_content_review.md) |
| Publish at a specified time | [Scheduling publication](scheduling.md) |
| Stop or resume delivery | [Unpublishing and restoring content](lifecycle.md) |
| Change the appearance or date display of a show website | [Show website](show_website.md) |
| Move from another hosting service | [Importing and migrating an RSS feed](rss_migration.md) |
| Check delivery counts by episode | [Delivery statistics](delivery_statistics.md) |
| Check the status after an error or interruption | [Troubleshooting](troubleshooting.md) |
| Back up management files or restore them on another device | [Backup and restore](workspace_backup.md) |
| Update the delivery server | [Service maintenance](maintenance.md) |
| Use a custom domain | [Custom domains](custom_domains.md) |
| Ask an AI agent to manage a podcast | [Managing a podcast with an agent](agent_usage.md) |

## Terms

| Term | Meaning |
| --- | --- |
| Service | A delivery environment created on Cloudflare. One service can manage multiple shows. |
| Show | A podcast, with its own RSS feed and episodes. |
| Episode | An audio recording and its metadata, including a title, description, and publication date. |
| Workspace | The local folder containing configuration, administrator keys, and editable show files. |
| Revision | A version of content saved at publication, used to review history and restore previous versions. |

## Managing your files

The workspace contains the service configuration in `castloop.toml`, a folder for each show, and `.castloop/`, which contains administrator keys. Keep these files and your original audio, and create regular [backups](workspace_backup.md). Treat `.castloop/` as confidential and keep it out of Git and shared locations.

Run operations one at a time, and wait for each command to finish before making further edits or running another operation.

To check a command's arguments, run `castloop help COMMAND`.

## Related documentation

- [v0.8.2 release notes](release-v0.8.2.md) (Japanese)
- [Development and release documentation](development/README.md) (Japanese)
- [Design documentation](../design/README.md) (Japanese)
- [Archived documents](archive/README.md)
