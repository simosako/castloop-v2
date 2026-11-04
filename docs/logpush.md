# Long-term access logs with Logpush

HTTP Requests Logpush records accesses to the audio and cover paths on your service's custom domain and stores them in a separate private R2 bucket for 400 days. It works with the current Worker delivery path; switching media delivery to R2/CDN is not required.

The setup and status commands are available. The `stats refresh`, `stats access`, and `stats logs` commands are planned for the next implementation step. Existing [`stats` commands](delivery_statistics.md) continue to display Worker delivery statistics.

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
