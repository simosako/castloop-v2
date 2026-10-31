# Delivery statistics

You can view audio delivery counts and transferred data by episode. The statistics count accesses to audio files, including repeated downloads by the same person and partial downloads.

Run the following commands in the service workspace. To run them elsewhere, add `--workspace /path/to/workspace`.

## View recent delivery

```sh
castloop stats my-show
```

This displays statistics for the past 30 days by episode. Dates are in UTC.

To choose a period, specify its start and end dates. You can view up to 366 days at a time:

```sh
castloop stats my-show --from 2026-10-01 --to 2026-10-25
```

If there are more results, specify the cursor from the result:

```sh
castloop stats my-show --cursor 'cursor from the previous result'
```

## View an episode in detail

```sh
castloop stats my-show --episode first --by-revision
```

This displays daily statistics and a breakdown by audio revision. If you replaced the audio, you can view the old and new audio separately. The episode total includes both.

Add `--json` to any of these commands to save or process the data.

## Understanding the numbers

| Metric | Meaning |
| --- | --- |
| `initial_downloads` | Downloads started from the beginning of the audio. Short probe requests are counted separately. |
| `equivalent_full_downloads` | Transferred bytes divided by audio file size, expressed as equivalent full downloads. |
| `audio_get_requests` | Total requests that returned audio data. |
| `response_bytes` | Total audio bytes in responses, including interrupted transfers. |
| `head_requests` / `not_modified_requests` | Requests for file information / cache validation requests that returned 304. |
| `probe_range_requests` | Requests for a very short range used to probe the file. |
| `bot_get_requests` / `bot_response_bytes` | Requests and transferred bytes from known bots or castloop delivery checks. |

Statistics are recorded after audio delivery, so they may take time to appear. Check `recording_error_count` for recording errors.

## Check daily coverage

The daily `STATUS` column (`coverage` in JSON) shows what each period represents:

| Status | Meaning |
| --- | --- |
| `measured` | The full day was measured. Days with no accesses show zero. |
| `partial` | Part of the first day of measurement, or the current day while aggregation is in progress. |
| `unmeasured` | A period before measurement began. |
| `pruned` | A period past the retention limit. It remains included in lifetime totals. |

`period` is the total for the selected period; `lifetime` includes data past the retention limit.

## Change daily data retention

The default is 400 days. You can set 30–3650 days per show. Check the current `retention_days` using `castloop stats my-show --json`.

For example, to set 180 days:

```sh
castloop stats-retention my-show 180
```

Run `stats` again to check the setting. Expired daily data is pruned over time but remains in lifetime totals. If you increase retention, previously pruned periods remain available only in lifetime totals.

## Example explanation for listeners

You can adapt the following text for your show website:

> This show collects daily audio delivery counts and transferred bytes for each episode. castloop statistics do not store individual IP addresses, cookies, device identifiers, or User-Agent strings. Please see Cloudflare's privacy policy for how Cloudflare handles connection information in its delivery infrastructure.
