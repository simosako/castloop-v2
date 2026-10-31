# Publishing and updating shows and episodes

To update a published show or episode, edit your local files, preview the changes, and publish. To create a new show or episode, see [publishing for the first time](getting_started.md).

The examples use `/path/to/workspace` as the workspace, `my-show` as the show ID, and `first` as the episode ID.

## 1. Edit the files

| Change | What to edit |
| --- | --- |
| Show name, description, or website settings | `my-show/show.toml` |
| Show cover | The image specified by `image_path` in `show.toml` |
| Episode title or description | `my-show/episode-first.toml` |
| Episode audio | Prepare a new MP3 file |

For a published episode, use its saved GUID and publication date. When replacing the cover, use an image with the same extension as the current one.

The size limit is 300,000,000 bytes for MP3 audio and 5,000,000 bytes for a JPEG or PNG cover.

## 2. Review and publish changes

Choose the example that matches your change. First run the preview alone and review the differences and assets.

After review, copy `input_fingerprint` from the preview result and use it as `REVIEWED_HASH` in the publish command.

### Update show information or cover

```sh
castloop preview-show my-show --workspace /path/to/workspace --remote --json
castloop publish-show my-show --workspace /path/to/workspace --expect-preview REVIEWED_HASH --json
```

### Update an episode title or description

Publish the edited information using the already published audio:

```sh
castloop preview-episode first --workspace /path/to/workspace --show my-show --remote --json
castloop publish-episode first --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

### Replace episode audio

Specify the new MP3 with an absolute path:

```sh
castloop preview-episode first /path/to/new.mp3 --workspace /path/to/workspace --show my-show --remote --json
castloop publish-episode first /path/to/new.mp3 --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

If you edit a file after previewing, preview again and use the new hash.

## 3. Check the result

In the publication result, `changed` means the update was applied; `unchanged` means the same content was already published. In either case, `revision_id` identifies the saved revision.

```sh
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

Also check the changes and audio on the show website.

If an error or disconnection leaves the result unclear, follow [the interruption checks](troubleshooting.md#when-an-operation-is-interrupted).

## Related operations

- [Schedule publication](scheduling.md): `published_at` is the date included in the RSS feed; the schedule determines when publication happens.
- [Review differences, RSS, and earlier revisions](published_content_review.md)
- [Unpublish or restore content](lifecycle.md)
