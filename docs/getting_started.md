# Create a service and publish your first episode

After [installing the CLI](installation.md), follow these steps:

1. Set Cloudflare credentials.
2. Create a service.
3. Publish a show.
4. Publish an episode.
5. Check the RSS feed and audio.

The examples use `/path/to/workspace` as the workspace and `my-show` as the show ID. Replace paths and names to suit your environment. After creating the workspace, run the commands from that directory unless noted otherwise.

For publication, the examples use `--review` to show a preview and ask for confirmation in one command. You do not need to copy a preview hash or run a separate publish command. No audio or cover is uploaded, and no content is published, until you confirm.

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

Choose a new folder for your management files, an unused service ID, and an unused R2 bucket name. Create the folder under an existing parent directory and move into it:

```sh
mkdir /path/to/workspace
cd /path/to/workspace
```

Initialize the service in the current directory and check its status:

```sh
castloop init --service-id my-service --bucket-name my-private-bucket --workers-subdomain my-account-subdomain
castloop service-status --json
```

`init` creates the delivery environment on Cloudflare and initializes the local workspace. Check that `publication_ready` is `true` in the `service-status` result.

Keep the workspace's `castloop.toml`, which contains the service configuration, and `.castloop/`, which contains administrator keys and operation records.

For a test show intended only for selected reviewers, set up [access protection](../design/security.md#非公開の実機試験) (Japanese) before uploading assets.

## 3. Publish a show

Register a show and create its local template. This does not publish the show. The example uses castloop's built-in show website:

```sh
castloop create-show my-show --site-mode builtin
```

Open the generated `my-show/show.toml` and enter the show name, description, author, owner contact details, and other fields. Use the [examples](../examples/README.md) (Japanese) as a reference when editing the generated file.

Place the show's cover image in `my-show/` and set `image_path` to its filename. Use a JPEG or PNG no larger than 5,000,000 bytes.

When ready, review and publish the show in an interactive terminal:

```sh
castloop publish-show my-show --review
```

`--review` displays the target, changes, cover path, and warnings without uploading or publishing. Check the show information and open the cover, then type `publish` to confirm. Press Enter to cancel. After confirmation, castloop checks the inputs and published state again before uploading and publishing.

## 4. Publish an episode

Create an episode template. This does not upload or publish the episode:

```sh
castloop create-episode first --show my-show
```

Open `my-show/episode-first.toml` and enter a title and description. Keep the generated GUID (the episode identifier) and check the publication date.

Prepare an MP3 no larger than 300,000,000 bytes, copy it into the show directory, and review the episode. Episode commands accept an absolute MP3 path or a path relative to the show directory. In this example, `audio.mp3` refers to `my-show/audio.mp3`.

```sh
cp /path/to/audio.mp3 my-show/audio.mp3
castloop publish-episode first audio.mp3 --show my-show --review
```

Check the target and changes in the preview, listen to the audio at the displayed local path, and type `publish` to confirm. Press Enter to cancel. If the inputs or published state change during the review, castloop asks you to review again, unless the same content is already published.

`--review` requires an interactive terminal and cannot be combined with `--json` or `--non-interactive`. To run separate preview and publication commands, including for automation, see [publishing and updating](publishing.md#use-separate-preview-and-publish-commands).

If `published_at` is in the future, publishing immediately requires an additional `publish now` confirmation. To wait until a specified time instead, use [scheduled publication](scheduling.md).

## 5. Check the RSS feed and audio

```sh
castloop list-episodes my-show --json
castloop verify my-show --episode first --json
```

Check `public_base_url` in `castloop.toml` and open these URLs in a browser:

| Content | URL |
| --- | --- |
| Show website | `<public_base_url>/podcasts/my-show/` |
| RSS feed | `<public_base_url>/podcasts/my-show/feed.xml` |

Check the show name and description, and play the audio.

After publishing, create a [workspace backup](workspace_backup.md). For later edits, see [Publishing and updating](publishing.md).

## Running commands from other directories

Episode commands can also run from the show directory or a subdirectory without `--workspace` or `--show`:

```sh
cd /path/to/workspace/my-show
castloop preview-episode first audio.mp3 --remote --json
```

Management commands and `backup-create` look for `castloop.toml` in the current directory and up to five parent directories, using the nearest one. They stop at the filesystem root and do not fall back to a more distant workspace if the nearest configuration is invalid. For Episode commands without `--show`, the first directory under the workspace must be a Show directory whose name matches the `show_id` in `show.toml`. Audio paths remain relative to that Show directory.

When a workspace cannot be found within the search limit, use `--workspace`. In an interactive terminal, management commands that select a workspace automatically display the workspace and service before the operation. `init`, `doctor`, and `preview-schedule-time` use the current directory instead of searching its parents.

To select the workspace explicitly from another directory, use `--workspace`. Episode commands also require `--show` when `--workspace` is specified:

```sh
castloop preview-episode first audio.mp3 --workspace /path/to/workspace --show my-show --remote --json
```

Use the explicit paths and show IDs when [working with an agent](agent_usage.md) or whenever the current directory is uncertain.
