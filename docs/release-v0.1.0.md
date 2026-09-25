# castloop v0.1.0

First administrator-operated MVP release for **Linux x86-64**. The standalone binary creates and updates a Cloudflare-hosted podcast service using `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; administrator machines need no Node.js, Bun, Wrangler, `ffprobe`, or R2 S3 credentials.

Download `castloop-linux-x64`, `SHA256SUMS`, `THIRD_PARTY_NOTICES.md`, and `LICENSE` from this release. castloop is distributed under the [MIT License](https://github.com/simosako/castloop-v2/blob/main/LICENSE). Verify the checksum with `sha256sum --check SHA256SUMS`, then install the binary as `castloop` with executable permissions. Follow the [README](https://github.com/simosako/castloop-v2#initialize-and-publish) to initialize a service and publish a Show and Episode. Keep the API token out of your service configuration and Git.

The MVP includes separate staging and explicit publication, episode metadata/audio-only revisions, durable job status and recovery, and a tested 300,000,000-byte MP3 limit. macOS and Windows binaries are not part of this release; their Cloudflare management flows have not been accepted.
