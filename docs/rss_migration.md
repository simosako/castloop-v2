# Importing and migrating an RSS feed

Follow these steps to move a podcast from another hosting service to a new castloop show:

1. Download the RSS feed and assets.
2. Review the show information and episodes.
3. Publish them with castloop.
4. Redirect subscriptions from the old service.

Use a public RSS 2.0 feed URL that you manage. Audio must be MP3 up to 300,000,000 bytes; covers must be JPEG or PNG up to 5,000,000 bytes.

## 1. Download the feed and assets

First check the number of episodes and any missing fields:

```sh
castloop import-rss my-show https://old-host.example/feed.xml --dry-run
```

Then specify a destination and download. The destination must be a new or empty folder; create its parent folder first.

```sh
castloop import-rss my-show https://old-host.example/feed.xml --output /path/to/import
```

The destination contains the original RSS feed, `show.toml`, a TOML file and MP3 for each episode, the cover, `import.json`, and `.castloop/`, which stores progress.

## 2. Review and edit

Once the download is complete:

1. Compare the episode count on the old service with the imported count. Episodes listed in the specified RSS feed are imported.
2. Check `missing_fields` and `warnings` in `import.json`.
3. Open `show.toml` and the episode TOML files and edit the show information, owner contact, titles, and descriptions.
4. Open the cover and play the MP3 files.
5. Review links to the old service in descriptions and update them to destinations that will remain available after migration.

Keep the episode GUIDs, publication dates, and `guid_is_permalink` values imported from the original RSS feed.

### Use the castloop show website

Set `site_mode` in `show.toml` as follows and remove the `site_url` line:

```toml
site_mode = "builtin"
```

To configure appearance or date display, see [Show website](show_website.md). If you use an external website instead, set `site_url` to a URL that will remain available after migration.

## 3. Publish with castloop

Prepare a destination using [Create a service](getting_started.md#2-create-a-service) and set the Cloudflare environment variables. The publication command below registers the show.

```sh
castloop service-status --workspace /path/to/workspace --json
```

Check that `publication_ready` is `true` before publishing.

For a test show intended only for selected reviewers, set up [access protection](../design/security.md#非公開の実機試験) (Japanese) first.

```sh
castloop publish-rss-import /path/to/import --workspace /path/to/workspace
```

The show information is published first, followed by episodes from oldest to newest. Completed episodes become available as the command runs, so keep the import files unchanged and wait for it to finish.

To publish an episode with a future publication date immediately, review the content and add `--allow-future-published-at`. To wait until the specified time, use [scheduled publication](scheduling.md).

When complete, open the `feed_url` in the output. Check the show information, episode count, GUIDs, publication dates, and descriptions, then play audio on the show website or in a podcast app.

## If the operation stops

Make sure the command has finished, then rerun the appropriate command:

| Where it stopped | How to continue |
| --- | --- |
| Download | Run `import-rss` with the same RSS URL, show ID, and `--output`. |
| Publication | Run `publish-rss-import` with the same import folder and workspace. |

The operation continues while checking saved assets and published content. Keep the import folder, assets, and progress records in `.castloop/`. After publication has started, use the same inputs when continuing.

## 4. Redirect subscriptions

After checking the new RSS feed and audio, configure a redirect to the new feed on the old service. Also update the RSS URL at each podcast directory according to its instructions.

[Apple's guidance](https://podcasters.apple.com/support/837-change-the-rss-feed-url) asks that redirects and related migration arrangements remain in place for at least four weeks. Confirm the migration and required retention period for each directory before ending your old service contract.
