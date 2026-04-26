# Contributing to Appstrate

Thank you for your interest in contributing to Appstrate! This guide covers everything you need to get started.

## Getting Help

- 💬 [Discord](https://discord.gg/5Js2CKWNnh) — quick questions, real-time chat with maintainers and the community
- 💡 [GitHub Discussions](https://github.com/appstrate/appstrate/discussions) — long-form questions, proposals, show-and-tell
- 🐛 [GitHub Issues](https://github.com/appstrate/appstrate/issues) — bug reports and feature requests only

## Code of Conduct

All participants are expected to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to Contribute

There are many ways to contribute beyond writing code:

- **Bug reports** — File issues with reproduction steps (see below)
- **Documentation improvements** — Fix typos, clarify guides, add examples
- **Translations** — Help translate the UI between French and English (i18next, `apps/web/src/locales/`)
- **Bug triage and issue labeling** — Help categorize and reproduce reported issues
- **Community support** — Answer questions on [Discord](https://discord.gg/5Js2CKWNnh) or in [GitHub Discussions](https://github.com/appstrate/appstrate/discussions)
- **Design feedback and UI/UX improvements** — Suggest usability improvements, report confusing workflows, propose UI enhancements
- **Feature requests** — Describe problems and propose solutions (see below)
- **Code contributions** — Bug fixes, new features, refactoring, tests

## Reporting Bugs

Use the [bug report template](https://github.com/appstrate/appstrate/issues/new?template=bug_report.yml) on GitHub. Include steps to reproduce, expected vs. actual behavior, and your environment details (OS, Bun version, Docker version).

## Suggesting Features

Use the [feature request template](https://github.com/appstrate/appstrate/issues/new?template=feature_request.yml). Describe the problem you're solving, your proposed solution, and any alternatives you've considered.

## Submitting Code

### Prerequisites

- [Bun](https://bun.sh/) (v1.3+) — that's it for Tier 0
- [Docker](https://docs.docker.com/get-docker/) (with Compose v2) — only needed for Tier 1+ or testing Docker agent execution

### Development Setup

**Tier 0 (zero-install, recommended for most development):**

```sh
git clone https://github.com/<your-username>/appstrate.git
cd appstrate
bun install
cp .env.example .env
bun run dev         # → http://localhost:3000
```

No Docker, no PostgreSQL, no Redis. Appstrate boots with PGlite (embedded database), filesystem storage, and in-memory adapters. This is sufficient for frontend work, API development, and most backend changes.

**Tier 3 (full stack, for Docker execution or production-like testing):**

```sh
bun install
bun run setup       # starts Docker infra, runs migrations, builds frontend
bun run dev         # → http://localhost:3000
```

See the [Progressive Infrastructure](./README.md#progressive-infrastructure) section in the README for all 4 tiers.

The `.env.example` ships with dev-ready defaults — no manual secret generation needed. For production, regenerate all secrets (see comments in `.env`).

**If you modify `runtime-pi/` or `runtime-pi/sidecar/`**, rebuild the Docker images:

```sh
bun run build-runtime    # agent image
bun run build-sidecar    # sidecar proxy image
```

### Useful Commands

| Command                        | Description                                         |
| ------------------------------ | --------------------------------------------------- |
| `bun run setup`                | One-command dev bootstrap (first time)              |
| `bun run dev`                  | Start API + web (turbo, hot-reload)                 |
| `bun run check`                | TypeScript + ESLint + Prettier + OpenAPI validation |
| `bun test`                     | All tests (~4500) — requires Docker                 |
| `bun test apps/api/test/unit/` | Unit tests only (fast, no DB)                       |
| `bun run build`                | Build frontend + shared packages                    |
| `bun run db:migrate`           | Apply database migrations                           |
| `bun run verify:openapi`       | OpenAPI spec validation                             |

### Branch Naming

- `feat/short-description` — New features
- `fix/short-description` — Bug fixes
- `docs/short-description` — Documentation
- `refactor/short-description` — Refactoring

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add webhook retry configuration
fix: prevent duplicate cron runs
docs: update API overview table
refactor: extract credential validation into service
```

### Code Style

- **TypeScript**: Strict mode, ESLint flat config, Prettier (semi, doubleQuote, trailingComma: all, printWidth: 100)
- **No `console.*`**: Use `@appstrate/core/logger` (pino JSON)
- **Validation**: Zod 4 for request bodies, AJV for dynamic manifest schemas
- **Testing**: `bun:test` with `it()` (not `test()`)
- **Language**: French for user-facing text (i18next), English for code and comments

### Commit Signing

We recommend signing your commits with GPG or SSH keys. This is not currently required but may become mandatory for maintainers in the future.

```sh
# GPG
git config commit.gpgsign true

# SSH
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git config commit.gpgsign true
```

### Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with clear, focused commits
3. Ensure `bun run check` and `bun test` pass
4. Open a PR against `main` with a clear description
5. Wait for CI checks and code review
6. Squash and merge after approval

### Review Criteria

- Quality gate passes (`bun run check` + `bun test`)
- Changes match the PR description
- No unrelated changes bundled
- New features include tests
- API changes include OpenAPI spec updates

## Contributor License Agreement (CLA)

By submitting a pull request, you agree to the [CLA](https://cla-assistant.io/appstrate/appstrate). The CLA Assistant bot will guide you through the process on your first PR.

## Response Times

We aim to provide timely feedback on all contributions:

- **Issue acknowledgment**: Within 5 business days
- **Bug triage**: Within 10 business days
- **PR first review**: Within 10 business days
- **Security reports**: Within 48 hours (see [SECURITY.md](SECURITY.md))

These are goals, not guarantees. We appreciate your patience as the project grows.

## Recognition

All contributors are recognized in our release notes. Significant contributions may be highlighted in the project's changelog. We value every contribution — code, documentation, bug reports, and community support.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
