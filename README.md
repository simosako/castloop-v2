# castloop

[![Latest release](https://img.shields.io/github/v/release/simosako/castloop-v2)](https://github.com/simosako/castloop-v2/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[日本語](README_ja.md)

castloop is a podcast hosting tool that runs on your Cloudflare account. Use its command-line interface to manage your shows and episodes, publish an RSS feed and a website, and schedule content for release.

> **Early beta:** Commands and data formats may change incompatibly. Check the [release notes](https://github.com/simosako/castloop-v2/releases/latest) before installing or updating.

## Why castloop?

Podcast hosting services make publishing accessible, but their interfaces and plans may not offer the control you need. You might want to automate uploads, schedule an episode for a future date, or keep a growing archive without a hosting plan's fixed storage allowance.

castloop puts podcast management in your hands. Its CLI fits into scripts and other workflows, and its bundled Skill helps AI agents work with your shows. You can prepare and review changes before publishing, or schedule them for later. Your content is hosted in your own Cloudflare account, so storage can grow with your needs and Cloudflare usage and pricing apply.

castloop is designed to make use of Cloudflare's free tiers where possible. For example, R2 Standard storage includes 10 GB-month of storage per month in its free tier. Actual costs depend on storage, requests, and other Cloudflare services used; see [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current details. Individual MP3 files are limited to 300,000,000 bytes.

## Features

- Manage multiple podcasts from a CLI using local, editable TOML files.
- Publish episodes with audio, an RSS feed, and a built-in podcast website.
- Preview changes before publishing and schedule shows or episodes for a later date.
- Review published revisions and restore earlier content.
- Import an existing podcast from its RSS feed.
- Use a custom domain and view episode delivery statistics.
- Export a Skill to help an AI agent manage your podcast.

## Getting started

1. Download the CLI for your platform from the [latest release](https://github.com/simosako/castloop-v2/releases/latest) and follow the [installation guide](docs/installation.md).
2. Set up your Cloudflare credentials and create a service in your account.
3. Create a show and an episode, edit their TOML files, and prepare your cover image and MP3.
4. Preview and publish your content, then check your podcast website and RSS feed.

The [getting started guide](docs/getting_started.md) walks through the commands and setup. For example, after creating a service, you can create the local files for a show and its first episode with:

```sh
castloop create-show my-show --site-mode builtin --workspace /path/to/workspace
castloop create-episode first --workspace /path/to/workspace --show my-show
```

Edit the generated files, then follow the guide to preview and publish them. See `castloop --help` or `castloop help COMMAND` for available commands.

## Documentation

- [User guide](docs/README.md): publishing, scheduling, importing, backups, and ongoing administration.
- [AI agent usage](docs/agent_usage.md): export the Skill and work with an agent.
- [Design documentation](design/README.md) (Japanese): architecture and implementation details.
- [Contributing](CONTRIBUTING.md): development setup and contribution guidelines.
- [Changelog](CHANGELOG.md) and [releases](https://github.com/simosako/castloop-v2/releases): changes and version-specific notes.

## License

castloop is available under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices.
