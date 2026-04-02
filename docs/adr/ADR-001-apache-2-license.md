# ADR-001: Use Apache 2.0 for OSS Components

## Status

Accepted

## Context

Appstrate follows an open-core model (similar to Supabase). We need a license for the core platform that:

- Encourages enterprise adoption without legal friction
- Provides explicit patent protection for contributors and users
- Allows third parties to build commercial products on top of the platform
- Distinguishes clearly between the open-source core and proprietary extensions (cloud billing, registry)

Alternatives considered: MIT (no patent grant), AGPLv3 (too restrictive for enterprise adoption and downstream commercial use), BSL/SSPL (ambiguous commercial terms that discourage adoption).

## Decision

Use **Apache License 2.0** for all open-source components in the `appstrate/` repository, including the API, web frontend, runtime images, sidecar proxy, and the `@appstrate/core` library published on npm.

Proprietary components (`cloud/`, `registry/`) remain under separate private licenses and live in their own repositories.

A `NOTICE` file is maintained at the repository root as required by the license. A `TRADEMARK.md` file protects the Appstrate name and logo. A CLA (Contributor License Agreement) is enforced for external contributions.

## Consequences

**Positive:**

- Patent grant protects all users and contributors from patent claims related to contributed code
- Enterprise-friendly: legal teams are familiar with Apache 2.0 and approve it quickly
- Permissive "toolbox" model: anyone can build commercial products on top of Appstrate
- Clear boundary between OSS (`appstrate/`) and proprietary (`cloud/`, `registry/`) code

**Negative:**

- Requires maintaining a `NOTICE` file with attribution for bundled third-party works
- Does not prevent competitors from forking and rebranding (mitigated by trademark policy and CLA)
- Contributors must agree to the CLA before their contributions can be merged

**Neutral:**

- Compatible with most other open-source licenses for dependency consumption
- The `@appstrate/core` npm package inherits the same Apache 2.0 license
