# Create a service and publish your first episode

After [installing the CLI](installation.md), follow these steps:

1. Set Cloudflare credentials.
2. Create a service.
3. Publish a show.
4. Publish an episode.
5. Check the RSS feed and audio.

The examples use `/path/to/workspace` as the workspace and `my-show` as the show ID. Replace paths and names to suit your environment.

## 1. Set Cloudflare credentials

Find the following in the Cloudflare dashboard:

- Your account ID
- An API token with permission to manage Workers, R2, and SQLite Durable Objects
- The `workers.dev` subdomain you want to use

Set the credentials as environment variables in your terminal.

On Linux or macOS:

```sh
export CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="API_TOKEN"
```

In Windows PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "ACCOUNT_ID"
$env:CLOUDFLARE_API_TOKEN = "API_TOKEN"
```

## 2. Create a service

Choose a new folder for your management files, an unused service ID, and an unused R2 bucket name.

```sh
castloop init /path/to/workspace --service-id my-service --bucket-name my-private-bucket --workers-subdomain my-account-subdomain
castloop service-status --workspace /path/to/workspace --json
```

`init` creates the delivery environment on Cloudflare and a local workspace. Check that `publication_ready` is `true` in the `service-status` result.

Keep the workspace's `castloop.toml`, which contains the service configuration, and `.castloop/`, which contains administrator keys and operation records.

For a test show intended only for selected reviewers, set up [access protection](../design/security.md#非公開の実機試験) (Japanese) before uploading assets.

## 3. Publish a show

Create a show template. This example uses castloop's built-in show website:

```sh
castloop create-show my-show --site-mode builtin --workspace /path/to/workspace
```

Open the generated `my-show/show.toml` and enter the show name, description, author, owner contact details, and other fields. Use the [examples](../examples/README.md) (Japanese) as a reference when editing the generated file.

Place the show's cover image in `my-show/` and set `image_path` to its filename. Use a JPEG or PNG no larger than 5,000,000 bytes.

When ready, preview the show:

```sh
castloop preview-show my-show --workspace /path/to/workspace --remote --json
```

Review the show information and cover, then copy `input_fingerprint` from the result. Replace `REVIEWED_HASH` with that value and publish:

```sh
castloop publish-show my-show --workspace /path/to/workspace --expect-preview REVIEWED_HASH --json
```

## 4. Publish an episode

Create an episode template:

```sh
castloop create-episode first --workspace /path/to/workspace --show my-show
```

Open `my-show/episode-first.toml` and enter a title and description. Keep the generated GUID (the episode identifier) and check the publication date.

Prepare an MP3 no larger than 300,000,000 bytes and preview the episode. An absolute path makes the audio file location clear.

```sh
castloop preview-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --remote --json
```

Review the content and audio, then publish using the resulting `input_fingerprint`:

```sh
castloop publish-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --expect-preview REVIEWED_HASH --json
```

To publish at a specified time, use [scheduled publication](scheduling.md) instead of the publish command.

## 5. Check the RSS feed and audio

```sh
castloop list-episodes my-show --workspace /path/to/workspace --json
castloop verify my-show --episode first --workspace /path/to/workspace --json
```

Check `public_base_url` in `castloop.toml` and open these URLs in a browser:

| Content | URL |
| --- | --- |
| Show website | `<public_base_url>/podcasts/my-show/` |
| RSS feed | `<public_base_url>/podcasts/my-show/feed.xml` |

Check the show name and description, and play the audio.

After publishing, create a [workspace backup](workspace_backup.md). For later edits, see [Publishing and updating](publishing.md).
