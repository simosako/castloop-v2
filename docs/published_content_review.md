# Reviewing content and restoring revisions

This guide explains how to review changes and RSS before publication and restore previously saved content.

## Review changes before publication

After editing an episode, compare it with the published version:

```sh
castloop preview-episode first --workspace /path/to/workspace --show my-show --remote --json
```

To replace audio as well, specify the MP3's absolute path after `first`. To compare show information, use `preview-show my-show`.

Check these fields:

| Field | Meaning |
| --- | --- |
| `published` | Current content saved on the server |
| `local` | Locally edited content |
| `changes.metadata_fields` | Changed fields |
| `assets` | Cover and audio to be used |
| `unchanged` | `true` if the content matches the published version |

If the content is correct, use `input_fingerprint` to [publish](publishing.md). If you edit the input, preview again.

## Review RSS in a file

Add `--rss-output` to a preview to save the RSS feed with your changes locally. Specify a new filename:

```sh
castloop preview-episode first --workspace /path/to/workspace --show my-show --remote --rss-output /path/to/preview.xml --json
```

Open `preview.xml` and review the show information and episodes. New audio URLs are placeholders. To review the audio and cover themselves, use the local files listed in the preview's `verification_paths`.

## Review and restore revisions

### 1. Find the revision

List the episode's revisions:

```sh
castloop list-episode-revisions first --workspace /path/to/workspace --show my-show --json
```

For show information, use `list-show-revisions my-show`.

Revisions are listed newest first. If more results are available, pass `next_cursor` from the result to `--cursor` to fetch the next page.

### 2. Review the differences

Replace `SAVED_REVISION_UUID` with the selected revision's `revision_id` and save a plan for review:

```sh
castloop preview-episode-revision first SAVED_REVISION_UUID --workspace /path/to/workspace --show my-show > /path/to/workspace/revision-plan.json
```

For show information, use `preview-show-revision my-show SAVED_REVISION_UUID`.

Open the plan and review the current content, selected revision, differences, and assets. Executing the plan publishes the selected revision. To restore an episode, first make sure its show is published.

### 3. Restore the reviewed revision

Replace `REVIEWED_REQUEST_SHA256` with the plan's `request_sha256`. Enter the final `confirm` exactly as shown.

```sh
castloop revision-execute revision-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

Afterward, [verify delivery](troubleshooting.md#verify) and review the content on the show website. The restored content is also available in the revision history.

## Export server content to TOML

Restoring a revision does not change local editable files. To use the server's current content as the basis for editing, specify its current `revision_id` and export it to a new TOML file. Create the output directory first.

```sh
castloop sync-local-metadata --workspace /path/to/workspace --show my-show --episode first --expect-revision CURRENT_REVISION_UUID --output /path/to/exported-episode.toml --json
```

Review the exported TOML before applying it to your local editable file. Use your retained original audio and cover files.
