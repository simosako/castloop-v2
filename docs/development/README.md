# Development and release documentation

These documents are for people developing and distributing castloop. For podcast management, see the [user guide](../README.md).

## Start development

1. Set up your environment and run the tests using [CONTRIBUTING.md](../../CONTRIBUTING.md).
2. Review the relevant components in the [design documentation](../../design/README.md) (Japanese).
3. Verify your changes using the [testing guide](../../design/testing.md) (Japanese).

## Update a release

- [Build and release the CLI](releasing.md)
- [Update actions used by release CI](ci_security.md)

Before testing against a live Cloudflare environment, obtain approval for the target and operations and review the [private testing requirements](../../design/security.md#非公開の実機試験) (Japanese).
