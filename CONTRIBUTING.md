# Contributing to Appstrate

Thank you for your interest in contributing to Appstrate! This guide covers everything you need to get started.

## Getting Help

- 💬 [Discord](https://discord.gg/5Js2CKWNnh) — quick questions, real-time chat with maintainers and the community
- 🐛 [GitHub Issues](https://github.com/appstrate/appstrate/issues) — bug reports, feature requests, and long-form proposals

## Code of Conduct

All participants are expected to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to Contribute

There are many ways to contribute beyond writing code:

- **Bug reports** — File issues with reproduction steps (see below)
- **Documentation improvements** — Fix typos, clarify guides, add examples
- **Translations** — Help translate the UI between French and English (i18next, `apps/web/src/locales/`)
- **Bug triage and issue labeling** — Help categorize and reproduce reported issues
- **Community support** — Answer questions on [Discord](https://discord.gg/5Js2CKWNnh)
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

**If you modify `runtime-pi/` or `runtime-pi/sidecar/`**, rebuild the runtime images:

```sh
bun run build-runtime    # rebuilds BOTH appstrate-pi and appstrate-sidecar
```

There is deliberately no command that rebuilds one of the two. `PI_IMAGE` and
`SIDECAR_IMAGE` are a version contract — the agent runtime and the sidecar speak
a wire protocol that changes in the same commit — and a pair built from two
different commits starts normally, passes every health check, then fails runs
with an error that names neither image (#1195). Both images are stamped with the
git revision they were built from, and the platform warns at boot when the two
stamps disagree.

### Useful Commands

| Command                        | Description                                                    |
| ------------------------------ | -------------------------------------------------------------- |
| `bun run setup`                | One-command dev bootstrap (first time)                         |
| `bun run dev`                  | Start API + web (turbo, hot-reload)                            |
| `bun run check`                | The full quality gate — 18 tasks, listed in `CLAUDE.md`        |
| `bun test`                     | All tests (~11,400 `it()` across ~875 files) — requires Docker |
| `bun test apps/api/test/unit/` | Unit tests only (fast, no DB)                                  |
| `bun run build`                | Build frontend + shared packages                               |
| `bun run db:migrate`           | Apply database migrations                                      |
| `bun run verify:openapi`       | OpenAPI spec validation                                        |

**Working on the Firecracker execution backend?** It's an opt-in built-in module (`apps/api/src/modules/firecracker/`, not in the default `MODULES`). The privileged engine runs as the `appstrate-runner` daemon (`bun run firecracker:runner`) and needs a Linux KVM host (`/dev/kvm`) — on macOS, run it inside a Lima VM with nested virtualization. Guest artifacts build via `bun run firecracker:build:{kernel,rootfs}`. Architecture + dev workflow: [`docs/architecture/FIRECRACKER.md`](./docs/architecture/FIRECRACKER.md).

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

Step 5 is currently advice rather than a rule. The `Protect main` ruleset
(`gh api repos/appstrate/appstrate/rulesets/14614228`) carries only `pull_request` and
`non_fast_forward`; it declares **no** `required_status_checks`, and
`repos/appstrate/appstrate/branches/main/protection` returns 404. So every gate in this repository —
`check`, the test suites, CodeQL, secret scanning — is mergeable red today.

### Required Checks (maintainers)

The set that should gate a merge. Names are the GitHub check-run names, verbatim
(`gh api repos/appstrate/appstrate/commits/main/check-runs --jq '.check_runs[].name'`):

| Check                                                   | Workflow       |
| ------------------------------------------------------- | -------------- |
| `check`                                                 | `check.yml`    |
| `Package resolves for consumers (packages/core)`        | `check.yml`    |
| `Package resolves for consumers (packages/afps-shared)` | `check.yml`    |
| `Unit tests`                                            | `test.yml`     |
| `Platform container health e2e`                         | `test.yml`     |
| `Secret Scanning`                                       | `security.yml` |
| `Analyze`                                               | `codeql.yml`   |

Deliberately **not** required, because a required check that does not report blocks the PR forever:
`Integration tests`, `Runtime container e2e` and `E2E tests` are label-gated
(`if: contains(github.event.pull_request.labels.*.name, …) || github.ref == 'refs/heads/main'`), so
they are absent from an unlabelled PR, and `Scorecard Analysis` has no `pull_request` trigger at all.
The same rule applies to any check added later: require it only once it is observed reporting on an
ordinary PR.

Applying it — a ruleset `PUT` **replaces** the whole ruleset, so read the live one and merge into it
rather than writing a body from scratch:

```sh
gh api repos/appstrate/appstrate/rulesets/14614228 > /tmp/main-ruleset.json

jq '.rules += [{
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: "check" },
          { context: "Package resolves for consumers (packages/core)" },
          { context: "Package resolves for consumers (packages/afps-shared)" },
          { context: "Unit tests" },
          { context: "Platform container health e2e" },
          { context: "Secret Scanning" },
          { context: "Analyze" }
        ]
      }
    }]
  | del(.id, .source_type, .source, .node_id, .created_at, .updated_at, ._links,
        .current_user_can_bypass)' \
  /tmp/main-ruleset.json > /tmp/main-ruleset-update.json

gh api --method PUT repos/appstrate/appstrate/rulesets/14614228 --input /tmp/main-ruleset-update.json
```

`del(...)` rather than a `{name, target, …}` whitelist: the whitelist form emits `bypass_actors: null`
when the live ruleset has none, and picking the fields to keep is the version of this edit that
silently drops whatever GitHub adds to the payload next.
`strict_required_status_checks_policy: false` means a PR does not have to be rebased onto the newest
`main` before merging; set it to `true` only if stale-base merges become a real problem, since it
makes every merge to `main` invalidate every open PR's status.

### Review Criteria

- Quality gate passes (`bun run check` + `bun test`)
- Changes match the PR description
- No unrelated changes bundled
- New features include tests
- API changes include OpenAPI spec updates
- A change to a request the SPA sends includes a test that pins the emitted payload (see `apps/web/CLAUDE.md`, Tests) — the typed client checks shapes, not values

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
