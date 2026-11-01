# castloop

[![Latest release](https://img.shields.io/github/v/release/simosako/castloop-v2)](https://github.com/simosako/castloop-v2/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[日本語](README_ja.md)

castloop is a podcast hosting tool that runs in your Cloudflare account. Use its command-line interface (CLI) to manage shows and episodes, publish an RSS feed and website, and schedule releases. You need a Cloudflare account; Cloudflare usage and pricing apply.

> **Early beta:** Commands and data formats may change incompatibly. Check the [release notes](https://github.com/simosako/castloop-v2/releases/latest) before installing or updating.

## Why castloop?

Podcast hosting services make publishing accessible, but their interfaces and plans may not offer the control you need. You might want to automate uploads, schedule an episode for a future date, or keep a growing archive without a hosting plan's fixed storage allowance.

castloop puts podcast management in your hands. Its CLI fits into scripts and other workflows. You can also install the bundled Skill in a supported AI agent and ask it to manage your podcast; you review proposed changes before telling it to publish. Prepare and review changes yourself, or schedule them for later. Your content is hosted in your Cloudflare account, where storage can grow with your needs.

castloop is designed to make use of Cloudflare's free tiers where possible. For example, R2 Standard storage includes 10 GB-month of storage per month in its free tier. Actual costs depend on storage, requests, and other Cloudflare services used; see [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current details. Individual MP3 files are limited to 300,000,000 bytes.

## Features

- Manage multiple podcasts from a CLI using local, editable TOML files.
- Publish episodes with audio, an RSS feed, and a built-in podcast website.
- Preview changes before publishing and schedule shows or episodes for a later date.
- Review published revisions and restore earlier content.
- Import an existing podcast from its RSS feed.
- Track audio delivery counts and transferred data by episode with the CLI.
- Use a custom domain for your podcast website and RSS feed.
- Install the bundled Skill in an AI agent to ask it to manage your podcast, and review changes before publication.

## Getting started

1. Download the CLI for your platform from the [latest release](https://github.com/simosako/castloop-v2/releases/latest) and follow the [installation guide](docs/installation.md).
2. Set your Cloudflare credentials and run `castloop init` to create a service and local workspace.
3. Create a show and episode, edit their TOML files, and prepare a cover image and MP3.
4. Preview your changes, publish them, then check the show website and RSS feed.

The [getting started guide](docs/getting_started.md) walks through setup and your first publication. For example, after installing the CLI and creating a service, create the local files for a show and its first episode with:

```sh
castloop create-show my-show --site-mode builtin --workspace /path/to/workspace
castloop create-episode first --workspace /path/to/workspace --show my-show
```

Edit the generated files, then follow the guide to preview and publish them. See the [delivery statistics guide](docs/delivery_statistics.md) to check episode activity, or `castloop --help` and `castloop help COMMAND` for available commands.

## Documentation

- [User guide](docs/README.md): publishing, scheduling, importing, backups, and ongoing administration.
- [Delivery statistics](docs/delivery_statistics.md): view episode audio delivery counts and transferred data.
- [Custom domains](docs/custom_domains.md): optionally use your own domain.
- [AI agent usage](docs/agent_usage.md): install the Skill in an agent and ask it to manage your podcast.
- [Design documentation](design/README.md) (Japanese): architecture and implementation details.
- [Contributing](CONTRIBUTING.md): development setup and contribution guidelines.
- [Changelog](CHANGELOG.md) and [releases](https://github.com/simosako/castloop-v2/releases): changes and version-specific notes.

## License

castloop is available under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices.
