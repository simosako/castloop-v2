# Setting up and changing a custom domain

You can set a dedicated subdomain such as `podcasts.example.com` as the delivery address for a service. All shows in that service use the same domain.

## 1. Prepare the domain

You will need:

- A domain whose DNS is managed in the same Cloudflare account as the Worker
- An unused subdomain for delivery
- The domain's Zone ID
- An API token with the usual administrative permissions, plus permission to read the zone and DNS and manage Workers Routes

In the Cloudflare dashboard, check that the domain's zone is active. Set your account ID and API token as environment variables and have the service workspace ready.

Delivery pauses during the switch, and scheduled publications require reapproval, so choose a suitable time for the change. Let castloop manage DNS and Worker domain settings during the switch.

## 2. Add the custom domain

Check the service status:

```sh
castloop service-status --workspace /path/to/workspace --json
```

Replace the hostname and Zone ID with your values and run:

```sh
castloop domain add podcasts.example.com --zone-id ZONE_ID --workspace /path/to/workspace --json
```

castloop connects the domain, checks DNS and TLS, and switches delivery. Save the operation ID shown in the result. If the operation is interrupted, see [Checking and continuing an interrupted operation](#checking-and-continuing-an-interrupted-operation).

## 3. Check delivery

```sh
castloop domain list --workspace /path/to/workspace --json
castloop service-status --workspace /path/to/workspace --json
```

Check the new domain and `publication_ready: true`, then open the RSS feed, show website, and audio in a browser. The local `castloop.toml` is also updated with the new public URL.

After the switch, the previous `workers.dev` RSS URL redirects to the custom domain. For subsequent edits, preview and publish using the new configuration.

If you have scheduled publications, [reapprove them](scheduling.md#reapprove-a-schedule).

## Checking and continuing an interrupted operation

Replace `OPERATION_UUID` with the interrupted operation's ID and check its status:

```sh
castloop domain status OPERATION_UUID --workspace /path/to/workspace --json
```

Check the target domain and change, then continue the same operation:

```sh
castloop domain continue OPERATION_UUID --workspace /path/to/workspace --json
```

`domain_tls_pending` means DNS and TLS are not yet ready; `domain_rollout_pending` means the Worker update is pending. Wait, check the status, and continue. Keep using the workspace and the operation records in `.castloop/`.

## Remove a custom domain

Removing a custom domain returns delivery to `workers.dev`. Podcast apps may remember the custom-domain URL, so first check how to change subscription URLs, notify listeners, and update registrations with podcast directories.

```sh
castloop domain remove --workspace /path/to/workspace --json
```

Afterward, check `domain list` and `service-status` and open the RSS feed and audio on `workers.dev`. Reapprove any scheduled publications after this change as well.
