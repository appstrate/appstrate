# Governance

## Project Vision

Appstrate is an open-source platform for running autonomous AI agents in sandboxed Docker containers. It enables users to connect providers, configure agents, and let AI agents process their data autonomously.

## Governance Model

Appstrate follows a **corporate-backed open-source model** (similar to Supabase). The Appstrate team retains final authority over the project roadmap, architecture, and releases. Community input is welcomed and encouraged through GitHub Issues, Discussions, and the RFC process described below.

The core platform is licensed under [Apache 2.0](./LICENSE). Commercial extensions (cloud billing, registry) are maintained separately in private repositories.

## Roles

### Contributor

Anyone who submits a pull request, opens an issue, participates in discussions, or improves documentation. All contributors must agree to the project's [Contributor License Agreement (CLA)](#contributor-license-agreement) before their first PR can be merged.

### Maintainer

Core team members with merge access to the repository. Maintainers review pull requests, triage issues, and participate in architectural decisions. The current list of maintainers is in [MAINTAINERS.md](./MAINTAINERS.md).

### Lead

Sets the project direction, resolves conflicts, and makes final decisions when consensus cannot be reached. The lead is responsible for ensuring the project stays aligned with its vision.

## Decision-Making Process

### Minor Changes

Bug fixes, documentation improvements, small features, and refactors require approval from **one maintainer** on the pull request. The reviewing maintainer merges once CI passes and the change meets project standards.

### Major Changes

Significant features, API changes, new dependencies, or architectural shifts require an **RFC** (see below). After a 2-week discussion period, maintainers reach consensus before implementation begins.

### Breaking Changes

Any change that breaks backward compatibility requires:

1. An RFC via GitHub Discussions with a 2-week discussion period
2. A `CHANGELOG.md` entry describing the change
3. A migration guide for affected users
4. Maintainer consensus before merging

## RFC Process

1. **Open a Discussion** — Create a new GitHub Discussion using the RFC category. Title it `RFC: <short description>`. Include motivation, proposed design, alternatives considered, and migration impact.
2. **Discussion Period** — The RFC remains open for a minimum of **2 weeks**. Community members and maintainers provide feedback, raise concerns, and suggest alternatives.
3. **Maintainer Review** — After the discussion period, maintainers review the RFC and reach consensus. The RFC is either accepted, rejected, or sent back for revision.
4. **Implementation** — Accepted RFCs are tracked as GitHub Issues. The RFC author or any contributor may submit a pull request implementing the proposal.

## Becoming a Maintainer

Maintainer status is earned through sustained, high-quality contributions. The path typically involves:

- Consistent contributions over several months (code, reviews, documentation)
- Active participation in code reviews and issue triage
- Demonstrated understanding of the project architecture and conventions
- Nomination by an existing maintainer, followed by consensus among current maintainers

Maintainer status may be moved to emeritus if a maintainer becomes inactive for an extended period. Emeritus maintainers are recognized for their past contributions and may return to active status.

## Conflict Resolution

1. **Discussion** — Disagreements are first resolved through open discussion on the relevant issue or pull request.
2. **Maintainer Vote** — If discussion does not reach consensus, maintainers vote. A simple majority decides.
3. **Lead Decision** — If maintainers are tied, the project lead makes the final call.

## Contributor License Agreement

Contributors must sign a CLA before their first pull request can be merged. The CLA ensures that contributions can be distributed under the project license. The CLA bot will prompt new contributors automatically on their first PR.

## Code of Conduct

All participants are expected to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).
