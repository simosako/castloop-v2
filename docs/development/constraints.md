# Development constraints

Read the relevant sections before changing local input handling, concurrent local operations, CLI runtime requirements, service configuration, initialization, storage layout, Worker embedding, deployment configuration or lifecycle and domain operations. These policies define the supported development scope; exact format definitions remain in the linked design documents.

## Administrator runtime

Administer Cloudflare from the standalone CLI using `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and direct REST calls. Do not require Wrangler, Node.js or separate R2 credentials on the administrator's machine. Development and private trial tools have their own documented requirements.

## Local inputs and serial operations

Run operations that modify the same local storage location one at a time. Keep input files, including configuration, metadata and media, unchanged during processing. During backup creation, stop workspace edits and CLI mutations until the backup finishes.

A failure that requires violating these preconditions is not, by itself, evidence for additional defensive logic. For example, concurrent replacement of an MP3 during upload does not alone justify repeated full-file hashing, a new frozen copy or additional locking. Failures that occur while these preconditions are respected remain within the supported scope.

Preserve existing size and hash validation and error handling; report detected mismatches as errors rather than ignoring them. By itself, this policy does not authorize removing existing checks. The current upload checks are described in the [CLI design](../../design/components/cli.md#素材のアップロードと公開).

These are local operating preconditions, not an exemption from external-input validation or security controls. Preserve authentication, path protections, server-side base-revision and generation checks, cache-safe delivery gates, and published media and history. Local serial execution does not replace the [server-side conflict checks](../../design/components/show-do.md#更新元の照合).

## Supported service configuration and storage

Development supports fresh SQLite services using the current [service configuration schema](../../design/data/schemas.md#サービス設定). `init` uses this configuration by default.

Reject service schema version 1 and legacy storage layouts before IO or local state changes. Do not add migration paths, legacy layout support, adoption of existing resources or fallback behavior.

Service configuration versions are separate from shared content and request schema versions. Shared content and request schema version 1 remains supported; do not reject it as a legacy service configuration. See the [schema definitions](../../design/data/schemas.md) for each format.

## Worker embedding and code-only cleanup

Embed only the production Worker, whose entrypoint is `src/sqlite-worker.ts`.

During code-only cleanup, preserve existing Durable Object and cache class names, bindings, the compatibility date and persisted SQLite formats. These values connect the deployed code to existing resources and data. See the [Worker deployment configuration](../../design/architecture.md#workerの実装と配備設定) and [SQLite table design](../../design/data/sqlite.md) for their definitions.

## Lifecycle and domain operations

Physical content deletion is not implemented. Preserve the current [lifecycle and retention contracts](../../design/components/show-do.md#公開状態と再公開); do not transplant archived Queue deletion operations.

Concurrent external changes to the same hostname, DNS records or Worker domain during a castloop domain change are unsupported. Follow the [domain change contract](../../design/components/control-do.md#独自ドメインとサービス設定).
