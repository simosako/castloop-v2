# castloop

castloop is a serverless podcast hosting program. Once deployed, it runs with minimal ops.

## Overview
- Hosts public podcasts on CloudFlare.
- One deployment can host multiple shows.
- A CLI (`castloop`) manages shows and episodes.

## Development environment

- use mise to install development environment. (see .mise.toml)

```
mise install
```
- use npm to install node/javascript/typescript related packages. (see packages.json)

```
npm ci
```
- use codegraph to search codebase. codegraph cli itself is installed by mise.

```
codegraph init      # create index
```
you may need to create a sym-link from ~/.local/share/mise/shims/codegraph to ~/.local/bin to allow opencode use codegraph cli.

you don't need to run ``codegraph installl``, because this repo's AGENTS.md and opencode.jsonc contain settings for codegraph.

- use opencode v2 , MCP and skills

``.mise.toml`` doesn't contain opencode v2. you should install it manually.
``opencode.jsonc`` contains MCP settings.
``.agents/skills`` directory contains skills.

you need to set ``CLOUDFLARE_ACCOUNT_ID`` and ``CLOUDFLARE_API_TOKEN`` environment variable to use cloudflare MCP.

| Scope   | Permission         | Access |
| ------- | ------------------ | ------ |
| Account | Workers            | Admin  |
| Account | Workers R2 Storage | Edit   |
| Account | Account Settings   | Read   |
| Domain  | Workers Routes     | Edit   |


```
{
  "name": "castloop-v2-dev",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {
          "id": "98d78cd2433d4c3687191bc0244ef948"
        },
        {
          "id": "bf7481a1826f439697cb59a20b22293e"
        },
        {
          "id": "c1fde68c7bcc44588cbb6ddbc16d6480"
        },
        {
          "id": "28f4b596e7d643029c524985477ae49a"
        }
      ],
      "resources": {
        "com.cloudflare.api.account.YOUR_ACCOUNT_ID": {
          "com.cloudflare.api.account.zone.*": "*"
        }
      }
    }
  ],
  "condition": {}
}
```

## M1 development CLI

The source CLI runs with Bun. From this repository, use `bun packages/cli/src/index.ts` (or `npm run cli --`). A Bun single-file executable is planned for M4.

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
bun packages/cli/src/index.ts init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain
cd /path/to/workspace
bun /path/to/castloop-v2/packages/cli/src/index.ts create-show my-show \
  --site-url https://example.com/my-show
cd my-show
bun /path/to/castloop-v2/packages/cli/src/index.ts create-episode first-episode
```

Missing arguments are prompted for on an interactive terminal. Initialization creates a private R2 bucket, Queue, DLQ, Worker and commit-marker notification. It stores non-secret service settings in `castloop.toml`; `.castloop/` contains the local admin key and retry state and must remain private. The Worker only handles Show ID reservations during M1; publication commands and public feeds arrive in M2. An incomplete `init` or `create-show` can be rerun with the same workspace and ID. For details and verification, see [`design/m1_implementation_log.md`](design/m1_implementation_log.md).
