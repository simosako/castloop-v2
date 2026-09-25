# castloop v0.1.1

Patch release for the Linux x86-64 administrator-operated MVP.

This release aligns the tagged source tree, project metadata, and release license asset under the MIT License with the copyright notice `Copyright (c) 2026 Akira Shimosako`. It also corrects README installation, update, and recovery guidance and records the remaining milestone exceptions.

The CLI and Worker behavior is unchanged from v0.1.0. The release workflow rebuilds the standalone binary from this tagged source and publishes a matching checksum, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.

Download `castloop-linux-x64`, `SHA256SUMS`, `THIRD_PARTY_NOTICES.md`, and `LICENSE` from this release. Verify the checksum with `sha256sum --check SHA256SUMS`, then install the binary with executable permissions. Keep the Cloudflare API token out of service configuration and Git.
