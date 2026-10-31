# Scheduling publication

You can publish show or episode content at a specified date and time. Prepare the files, then preview the content and time before creating the schedule.

The dates below are examples. Replace them with the future dates you want to use.

## Optional administrator settings

To enter scheduled times in Japan time, create `castloop-admin.toml` at the root of the workspace:

```toml
schema_version = 1
timezone = "Asia/Tokyo"
```

With this setting, dates without an offset are interpreted in Japan time. The default is UTC. To specify the time zone per command, use `--timezone Asia/Tokyo`.

## 1. Review the content and time

Prepare the TOML and assets as you would for [normal publication](publishing.md). For a new episode, prepare an MP3 and publish the parent show first.

This example schedules episode `first` for 9:00 on December 1, 2026, in Japan time:

```sh
castloop preview-episode-schedule first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --json
```

Review the content, assets, local time, and UTC time in the preview, and copy `approval_sha256`. For an update using already published audio, you can omit the MP3 path.

To check how a date and time will be interpreted first, run:

```sh
castloop preview-schedule-time 2026-12-01T09:00:00 --workspace /path/to/workspace --timezone Asia/Tokyo --json
```

## 2. Create the schedule

Replace `REVIEWED_HASH` with the reviewed `approval_sha256`. Specify the same content, assets, and time as in the preview:

```sh
castloop schedule-episode first /path/to/audio.mp3 --workspace /path/to/workspace --show my-show --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --expect-preview REVIEWED_HASH --json
```

Save the schedule ID (`schedule_id`) from the result. The schedule saves the content as it was at this point; later edits to the TOML do not change it.

To schedule show information, also preview before scheduling and use the show's `approval_sha256`:

```sh
castloop preview-show-schedule my-show --workspace /path/to/workspace --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-show my-show --workspace /path/to/workspace --at 2026-12-01T09:00:00 --timezone Asia/Tokyo --expect-preview REVIEWED_HASH --json
```

## 3. Check the result

```sh
castloop schedule-list my-show --workspace /path/to/workspace --json
castloop schedule-status my-show SCHEDULE_UUID --workspace /path/to/workspace --json
```

Replace `SCHEDULE_UUID` with the schedule ID.

| Status | Meaning and action |
| --- | --- |
| `scheduled` | Scheduled. The server will publish at or after the specified time. |
| `dispatched` | Published. Check the `revision_id` and the show website. |
| `needs_approval` | A configuration or publication change requires another review. Follow the reapproval procedure below. |

The server handles the schedule after creation. Once the scheduled time has passed, check the result with `schedule-status`.

## Change a scheduled time

1. Preview the current schedule and the new time.
2. Replace `N` with `schedule.version` and `REVIEWED_HASH` with `approval_sha256` from the preview, then run the change.

```sh
castloop preview-schedule-reschedule my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --json
castloop schedule-reschedule my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --expect-version N --expect-preview REVIEWED_HASH --json
```

## Cancel a schedule

Review the target in the preview, then cancel using its version and hash:

```sh
castloop preview-schedule-cancel my-show SCHEDULE_UUID --workspace /path/to/workspace --json
castloop schedule-cancel my-show SCHEDULE_UUID --workspace /path/to/workspace --expect-version N --expect-preview REVIEWED_HASH --json
```

## Reapprove a schedule

Changing a custom domain or published content can put a schedule in `needs_approval`.

1. Check the reason and current `schedule.version` with `schedule-status`.
2. Replace `N` with that version and preview a future execution time.
3. Review the saved content and time, then reapprove using `approval_sha256`.

```sh
castloop preview-schedule-reapprove my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --expect-version N --json
castloop schedule-reapprove my-show SCHEDULE_UUID --workspace /path/to/workspace --at 2026-12-02T09:00:00 --timezone Asia/Tokyo --expect-version N --expect-preview REVIEWED_HASH --json
```

Reapproval uses the content saved in the schedule. To change the content as well, cancel the original schedule and create a new one with the edited content.

## Entering dates and times

- Join the date and time with `T`, as in `2026-12-01T09:00:00`.
- You can include an offset, as in `2026-12-01T09:00:00+09:00`. If you also specify `--timezone`, the offset must match that time zone.
- When a daylight saving transition makes a local time occur twice, specify the intended offset as well.
- An episode's `published_at` is the date shown in RSS. Use `--at` for the time publication should begin.
- To publish immediately with a future `published_at`, answer the confirmation during normal publication. With `--json`, add `--allow-future-published-at`.

Set the show website's date display separately using the [website time zone](show_website.md#publication-date-time-zone).
