# Long-term access logs with Logpush

HTTP Requests Logpush records accesses to the audio and cover paths on your service's custom domain and stores them in a separate private R2 bucket for 400 days. It works with the current Worker delivery path; switching media delivery to R2/CDN is not required.

Use `logpush` to configure collection, `stats refresh` to calculate and save access statistics, `stats access` to read them, and `stats logs` to export individual records. Existing [`stats SHOW` commands](delivery_statistics.md) continue to display Worker delivery statistics with their original definitions.

## Before setup

- Configure a custom domain with the [domain commands](custom_domains.md). Zone HTTP Logpush cannot collect requests to `workers.dev`.
- Choose a **new**, dedicated log bucket name, different from the private media originals bucket. Keep the local workspace and its management records.
- Confirm the target account, zone, bucket, token creation, and collection scope with the administrator. Resource setup and job changes require explicit authorization.
- Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Use the same account as `castloop.toml`; never put credentials in TOML, command arguments, or chat.

The administrator token needs the existing service management access plus these Cloudflare permissions:

| Permission | Purpose |
| --- | --- |
| Zone Read | Verify the active/full zone and its account |
| Logs Write for the zone | Check HTTP Requests fields and create, inspect, or update the job |
| Workers R2 Storage Write | Create the log bucket, inspect public access, and manage retention through REST |
| Account API Tokens Write | List permission groups and tokens, create the bucket-scoped destination token, and revoke an unused token after interrupted setup |

The service administrator key in `.castloop/secrets.json` verifies the running service before resource changes. The CLI does not require Wrangler, a separate S3 client, or manually supplied R2 access keys.

## Create the log destination and job

Run from the service workspace, or add `--workspace /path/to/workspace`:

```sh
castloop logpush setup --zone-id ZONE_ID --bucket-name my-service-access-logs
```

Setup verifies the current custom host and available HTTP Requests fields, then creates or checks:

1. A private R2 Standard bucket with `r2.dev` disabled and no custom domains.
2. A lifecycle rule deleting `http/<service_id>/` objects 400 days after creation. Other rules are preserved; overlapping deletion or storage-class rules must be reviewed before collection starts.
3. An account-owned R2 Object Read & Write token scoped to that log bucket only.
4. One HTTP Requests Logpush job per configured zone, initially enabled, writing gzip NDJSON under `http/<service_id>/<zone_id>/{DATE}/`.

The job includes GET/HEAD responses with status 200, 206, or 304 for `/podcasts/` audio and cover paths. It records external listener requests, including cache hits and bots. The ten selected fields contain timestamps, request IDs, host/path, method/status, body bytes, cache status, and the external/subrequest classification. IP addresses, cookies, User-Agent strings, query strings, and referrers are not selected.

Repeating setup with the same inputs checks the existing managed resources. It does not duplicate the job. It keeps the existing enabled/disabled setting. After a custom-domain change within the same zone, setup adds the current host while retaining previously configured hosts and their source identities. For a new zone, run setup with that zone and the same saved log bucket.

This step leaves `castloop.toml`, Worker deployment, public URLs, content, and existing statistics unchanged. Keep the returned IDs and the safe configuration in `.castloop/logpush/<service_id>/configuration.json`; [workspace backups](workspace_backup.md) include this file. Token values, secret access keys, and full destination configurations are never stored locally or printed.

## Inspect collection and retention

```sh
castloop logpush status --zone-id ZONE_ID --json
```

Status is read-only, including local files. Review:

| Field | Meaning |
| --- | --- |
| `bucket_exists`, `private`, `retention_valid` | Whether the destination exists, is private, and has the expected 400-day rule |
| `configuration_matches` | Whether the job matches the saved collection settings and the private retention checks pass |
| `settings.enabled`, `job_enabled` | The saved desired state and the observed remote state; `job_enabled` is `null` if the job is absent |
| `last_complete_at_ms`, `last_error_at_ms`, `delivery_error` | Cloudflare's reported delivery health; error text is represented by a flag, not copied into output |
| `sources` | Host-specific collection start times, latest successful delivery, metric definition, and known interruptions |

Before setup completes, status can report absent resources or a settings mismatch. If a job or token fails identity or privacy checks, status reports an error instead of printing the unverified API response.

Logpush delivery is best effort. An enabled, matching job does not prove that every request was delivered. The 400-day rule retains logs that reached R2; it does not recover missing deliveries. Setup success does not establish actual 12-month availability, measured storage use, or Free-plan compatibility for your account. Verify delivery and usage after obtaining authorization for that environment. Logpush export and R2 storage/operations consume account-wide allowances; see the [capacity design](../design/issue-122-logpush-design.md#10-無料枠と利用量).

## Stop or resume the saved job

```sh
castloop logpush disable --zone-id ZONE_ID
castloop logpush enable --zone-id ZONE_ID
```

These commands change the saved zone job, not content delivery. Disabling keeps the bucket, existing logs, retention rule, token, and source identities. All hosts in the job are affected. The CLI records the interruption before sending the disable request and closes it after a confirmed enable. Initial setup also records the interval before collection was confirmed, so later statistics can identify partial collection days.

These operations remain available after returning the service to `workers.dev`, so an old custom-domain job can be inspected or stopped. They do not start individual Worker logs on `workers.dev`.

## If a command is interrupted

Preserve the workspace and configuration file. Inspect `logpush status --zone-id ZONE_ID`, then explicitly rerun the **same action and inputs** after confirming authorization. Keep one modifying CLI process at a time, and finish the current operation before changing its inputs or editing resources externally.

The CLI saves an operation identifier before resource creation and checks current API state on rerun. If a destination token was created but no job uses it, setup revokes that operation's verified unused token and creates a replacement: the original secret was intentionally not retained. A job already created by that operation is checked and reused. Mutating HTTP requests are never automatically retried.

Existing unrelated buckets/jobs/tokens are not adopted. Missing completed resources, changed token permissions, unexpected filters, public access, or conflicting retention rules produce an error for review. Log objects and configured buckets/jobs are retained; bucket migration and removal of those resources are outside these commands.

## Calculate access statistics

Find the host's `source_id` in `logpush status --zone-id ZONE_ID --json`, then choose a Show and UTC dates:

```sh
castloop stats refresh my-show --source 'http_logpush:ZONE_ID:podcasts.example.com' --from 2026-10-01 --to 2026-10-31 --json
```

Replace the example source with the exact saved ID. Each refresh handles one source and Show. It reads all approved audio revisions and the cover, including old revisions and unpublished episodes. It deduplicates delivered requests by source, UTC date, and request ID, then replaces the daily values in that Show DO. Materials with no matching requests receive saved zero counts.

The default window is the last 30 UTC days, including today. A request spans at most 366 dates; refresh dates must also be within the current 400-day daily retention window. Dates entirely outside the source's collection period are listed in `skipped_collection_dates_utc` and are left unmeasured. The current day and known interruptions are shown as partial coverage.

Refresh checks the saved source and current Logpush configuration/retention. It requires the administrator key and Cloudflare permissions for status inspection and R2 REST reads. It does not change the job, token, bucket configuration, content, or Worker delivery counters.

All selected files must parse before the first daily replacement. Each date/material replacement uses the versions read before the R2 scan. The result reports `changed`, `unchanged`, input-file count, and newly found out-of-window dates in `new_outside_dates_utc`. Those dates can belong to other Shows in the same log file; review them before explicitly choosing another refresh window.

Repeating the same calculation does not add counts. The file index can be rebuilt without changing the result, and later log files can be included by repeating refresh. If a replacement fails midway, earlier rows may already be saved: inspect their read/applied timestamps with `stats access`, then explicitly rerun the same source/dates. The CLI does not automatically retry mutations. Previously observed interruption history is preserved when newer job observations are saved.

The CLI aggregates the selected events in management-device memory. Split long or busy periods into smaller windows when needed; a single large 12-month refresh has not been performance-tested. Individual-log export below streams records instead of collecting them in memory.

## Read saved access statistics

First list the Show's saved sources, then its approved material paths:

```sh
castloop stats access my-show
castloop stats access my-show --source 'http_logpush:ZONE_ID:podcasts.example.com'
```

Sources appear after the first successful refresh. The second command lists paths for all approved revisions and the cover; use one path for daily counts and the period total:

```sh
castloop stats access my-show --source 'http_logpush:ZONE_ID:podcasts.example.com' --resource '/podcasts/my-show/cover.jpg' --from 2026-10-01 --to 2026-10-31
```

Access readout requires only the administrator key. It reads Show DO data without scanning R2 or changing statistics. Dates are accepted when both `--source` and `--resource` are present. Add `--json` for the `sources`, `resources`, or `daily` view. Continue pages with the returned `next_cursor` and the same selectors and explicit dates; a daily page includes the selected period's total, not just the displayed rows.

| Value | Meaning |
| --- | --- |
| Saved counters of zero | The selected inputs were read and no matching requests were found |
| `unmeasured`, with a `null` record | No saved calculation for that date |
| `partial` | Source start/end, an interruption, or a read before the UTC day ended limits coverage |
| `pruned`, with a `null` record | Before the current 400-day daily retention boundary |

If the whole period has no saved rows, its total is `null`, not zero. `read_at_ms` is captured before listing the R2 input, and `applied_at_ms` records when the row was saved. A later check of identical inputs can advance the read time without incrementing its content version. Period totals include retained rows only; the existing Worker lifetime totals remain separate.

`access-daily-v1` reports GET 200/206, HEAD, GET 304, actual edge body bytes, and cache-status counts. It includes bots. Initial downloads, tiny-range probes, and bot exclusion are shown as unsupported, so these counts should be interpreted separately from `episode-daily-v1`.

## Export individual logs

```sh
castloop stats logs my-show --source 'http_logpush:ZONE_ID:podcasts.example.com' --from 2026-10-01 --to 2026-10-31 --output /private/path/my-show-access.ndjson --json
```

`--output` is required and uses the caller's working directory for relative paths. The destination must be new; the CLI creates it with mode 0600 and removes its own incomplete output on failure. Keep exports in a private location. Each line is a common access-event JSON object for the selected Show, host, UTC dates, and approved material paths. Delivery duplicates are retained, allowing the file to represent the delivered records; refresh performs deduplication when calculating statistics.

Standard output contains only the export summary or normal JSON envelope, never the individual records. The summary's `format` is `access-event-ndjson-v1`. Export uses the saved Logpush source, administrator key, and Cloudflare R2 REST read credentials; it can read retained logs while the job is stopped and does not require current job inspection. It creates/reuses the local read index but leaves Show DO statistics unchanged.

Export accepts up to 366 UTC dates at a time. R2 retains files by creation time, while filtering uses each event's occurrence time. The 400-day daily-statistics cutoff does not limit which still-retained individual records can be exported.
