# Unpublishing and restoring content

You can stop delivery of an entire show or an individual episode. Unpublished content and assets are retained and can be published again later.

## Unpublish an episode

### 1. Review the change

This example unpublishes episode `first` of show `my-show`:

```sh
castloop preview-episode-lifecycle my-show first unpublish --workspace /path/to/workspace > /path/to/workspace/unpublish-plan.json
```

Open `unpublish-plan.json` and check the show, episode, and resulting state.

### 2. Execute the plan

Replace `REVIEWED_REQUEST_SHA256` with the `request_sha256` from the plan. Enter `confirm` exactly as shown.

```sh
castloop lifecycle-execute unpublish-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

Afterward, check that the episode is no longer listed in the RSS feed or on the show website. Delivery of its page and audio also stops.

## Restore an episode

Restore the latest saved content. Publish the parent show first.

```sh
castloop preview-episode-lifecycle my-show first restore --workspace /path/to/workspace > /path/to/workspace/restore-plan.json
```

Review `restore-plan.json` and execute it using its `request_sha256`:

```sh
castloop lifecycle-execute restore-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

After restoring the episode, check its display and playback on the show website.

## Unpublish or restore an entire show

To stop delivery of a show, create a plan:

```sh
castloop preview-show-lifecycle my-show unpublish --workspace /path/to/workspace > /path/to/workspace/show-plan.json
```

Review the plan and execute it using its `request_sha256`:

```sh
castloop lifecycle-execute show-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/workspace --json
```

Delivery of the show's RSS feed, website, images, and audio stops.

To restore the show, replace `unpublish` with `restore` in the preview command, then review and execute the new plan. Episodes that were individually unpublished remain unpublished.

## Publish different content

- To publish local edits, follow [Publishing and updating](publishing.md).
- To restore a particular earlier version, see [Reviewing and restoring revisions](published_content_review.md#review-and-restore-revisions).
- If the result of an operation is unclear, see [When an operation is interrupted](troubleshooting.md#when-an-operation-is-interrupted).
