# Two-step install + closed-by-default — implementation plan

**Issue**: [#344 — Installer: secure-by-default signup mode + interactive prompts via /dev/tty for curl|bash](https://github.com/appstrate/appstrate/issues/344)
**Related**: [#199 — Bun-compiled CLI doesn't receive keypresses on macOS](https://github.com/appstrate/appstrate/issues/199), [#228 — closed-mode bootstrap], [#249 — dual-install detection]

## Goal

Replace the current `curl … | bash` semantics:

```
curl … | bash  →  download binary → exec `appstrate install --yes`  (silently OPEN mode)
```

with a two-step flow that bypasses the Bun `setRawMode`/`kqueue` regressions **by construction** and closes the silent-open footgun:

```
curl … | bash             → download binary → STOP, instruct "run `appstrate install`"  (interactive, full prompts)
curl … | bash -s -- --yes → download binary → exec `appstrate install --yes`  (closed-by-default + bootstrap token)
```

The CLI binary, when launched from the user's interactive shell, has full clack interactivity — neither Bun bug fires because there's no `setRawMode` under a shell-piped stdin and no `</dev/tty` redirect chain spawning subprocesses.

## Behaviour matrix

| Invocation                                                      | Today                                      | After                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `curl … \| bash` (TTY in stdout)                                | `install --yes` runs, **silent open mode** | Drop binary, print "Run: `appstrate install`", exit 0. User runs install interactively from real shell. |
| `curl … \| bash -s -- --yes`                                    | `install --yes`, silent open               | `install --yes`, **closed-by-default** + bootstrap token printed                                        |
| `curl … \| bash` (no TTY anywhere — Dockerfile RUN, cloud-init) | Hangs or fails                             | Treated like `--yes`: closed-by-default + token.                                                        |
| `APPSTRATE_BOOTSTRAP_OWNER_EMAIL=… curl … \| bash`              | Closed mode w/ named owner                 | Unchanged — env override always wins.                                                                   |
| `APPSTRATE_AUTO_INSTALL=1 curl … \| bash`                       | (n/a)                                      | New escape hatch: replicate current all-in-one behaviour for legacy Ansible/cloud-init scripts.         |
| `appstrate install` (binary already on PATH)                    | Interactive                                | Unchanged.                                                                                              |
| `appstrate install --yes`                                       | Open mode                                  | Closed-by-default + token (parity with `--yes` curl path).                                              |

Three exit conditions for the curl path:

1. **Drop & instruct** (TTY stdout, no `--yes`, no `APPSTRATE_AUTO_INSTALL`) — new default.
2. **Auto-install** (`--yes` OR no TTY anywhere OR `APPSTRATE_AUTO_INSTALL=1`) — exec the CLI, closed-by-default if no email override.
3. **Pre-existing dual install** — unchanged (lines 170-255 of `bootstrap.sh`).

## File-by-file changes

### `scripts/bootstrap.sh`

**Edit 1** — replace lines 501-546 (the `APPSTRATE_NO_LAUNCH` + `exec` block):

```sh
# ─── Launch decision ───────────────────────────────────────────────────────

# Decide between the new two-step default ("drop & instruct") and the
# legacy all-in-one auto-install. Three signals trigger auto-install:
#   1. user passed --yes explicitly (CI / scripted)
#   2. APPSTRATE_AUTO_INSTALL=1 (legacy escape hatch for Ansible/cloud-init)
#   3. genuinely non-interactive — no TTY on stdout AND no readable /dev/tty
#      (Dockerfile RUN, systemd unit, cron). The CLI's own `install` would
#      fail-fast on missing TTY anyway; running --yes for them is friendlier.
_wants_auto=0
case " $* " in *" --yes "*) _wants_auto=1 ;; esac
if [ "${APPSTRATE_AUTO_INSTALL:-0}" = "1" ]; then _wants_auto=1; fi
if [ ! -t 1 ] && [ ! -r /dev/tty ]; then _wants_auto=1; fi

# Legacy: APPSTRATE_NO_LAUNCH=1 still wins — caller wanted ONLY the binary
# drop, no install at all. Preserved verbatim for any existing scripted
# provisioning that depends on it.
if [ "${APPSTRATE_NO_LAUNCH:-0}" = "1" ]; then
  log "APPSTRATE_NO_LAUNCH=1: skipping install entirely. Binary at $DEST."
  exit 0
fi

if [ "$_wants_auto" = "0" ]; then
  # Two-step default — drop the binary and hand the user a copy-pasteable
  # next step. The CLI launched from their interactive shell gets full
  # clack prompts (no Bun setRawMode bug, no </dev/tty redirect chain).
  printf '\n'
  log "Appstrate CLI installed."
  log ""
  log "To complete setup, run:"
  printf '\n    \033[1;36m%s install\033[0m\n\n' "$DEST"
  log "Or in a new shell (PATH already updated):"
  printf '\n    \033[1;36mappstrate install\033[0m\n\n'
  log "For unattended/CI installs: re-run with \`-s -- --yes\`."
  exit 0
fi

log "Launching \`appstrate install --yes\`"
exec "$DEST" install --yes "$@"
```

**Edit 2** — keep the `--yes` exec path stripped of the long #199 comment block (move the rationale into ADR-006 supplement, see "Cleanup"). The comment stays valuable but doesn't need to live next to a 2-line `exec`.

### `apps/cli/src/commands/install.ts`

**Edit 3** — `resolveBootstrapEmail` (lines 227-263): when `nonInteractive && !fromEnv && opts.tier !== 0 && opts.mode === "fresh"`, instead of returning `{}` (open mode), generate a bootstrap token and return a new `BootstrapOverrides` shape that carries it.

```ts
// Pseudo-diff
if (opts.mode === "upgrade") return {};
if (opts.tier === 0) return {}; // Tier 0 stays open — local dev only
if (opts.nonInteractive) {
  // NEW: closed-by-default with one-time token instead of silent open
  return { bootstrapToken: generateBootstrapToken() };
}
// ... (interactive prompt unchanged)
```

`bootstrapToken` is a new optional field on `BootstrapOverrides`. Token generation: `randomBytes(32).toString("base64url")` — same primitive as existing secrets in `secrets.ts`.

**Edit 4** — `installCommand` (lines 127-207): after `installTier0` / `installDockerTier`, if `bootstrap.bootstrapToken` is present, print a 5-line banner with the token + URL to redeem it (post-`outro`, hard to miss). Wire into both `installTier0` and `installDockerTier` outro paths via `printBootstrapFollowup`.

### `apps/cli/src/lib/install/secrets.ts`

**Edit 5** — extend `BootstrapOverrides` (line 79):

```ts
export interface BootstrapOverrides {
  bootstrapOwnerEmail?: string;
  bootstrapOrgName?: string;
  /** One-time token for unattended installs (--yes / no TTY). When set,
   *  the install ships AUTH_DISABLE_SIGNUP=true with no named owner,
   *  and the operator claims the instance via this token. Mutually
   *  exclusive with bootstrapOwnerEmail. */
  bootstrapToken?: string;
}
```

**Edit 6** — `generateEnvForTier` (lines 96-160): when `bootstrap.bootstrapToken && !bootstrap.bootstrapOwnerEmail`, write:

```
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_BOOTSTRAP_TOKEN=<token>
```

The platform side (API) needs to honour `AUTH_BOOTSTRAP_TOKEN` — covered in **Edit 8**.

**Edit 7** — `renderEnvFile` (lines 176-184): when `AUTH_BOOTSTRAP_TOKEN` is present, replace the closed-mode footer with a token-redemption pointer.

### `packages/env/src/index.ts` + `apps/api/src/lib/auth.ts` (or equivalent)

**Edit 8** — add `AUTH_BOOTSTRAP_TOKEN` to the Zod env schema, document semantics: a one-time token that grants the redeemer owner role + creates the bootstrap org, then unsets itself (or, simpler v1, keeps working until a real owner exists). Surface in CLAUDE.md under the auth env table.

Wire into the auth pipeline:

- New route `POST /api/auth/bootstrap/redeem` accepting `{ token, email, name, password }` — creates the user, marks them as owner of `AUTH_BOOTSTRAP_ORG_NAME`, atomically clears `AUTH_BOOTSTRAP_TOKEN` from a runtime-cached state (token is single-use).
- After redemption, the instance behaves like any closed-mode install with a known owner.

This is the only platform-side change. Everything else is CLI-only.

### `apps/api/src/lib/buildAppConfig.ts` (frontend feature flag)

**Edit 9** — expose `bootstrapTokenPending: boolean` on `AppConfig` so the dashboard can show a "Claim this instance" landing page when an unredeemed token is set, instead of the normal login.

### Frontend (`apps/web/src/pages/`)

**Edit 10** — new page `pages/claim.tsx` rendered when `bootstrapTokenPending=true`. Form: email, name, password, **token paste**. Submits to `/api/auth/bootstrap/redeem`. On success: log the user in, redirect to dashboard.

## Cleanup (legacy/unused after this lands)

| File                                  | Lines                                            | Action                                                                                                                                       | Rationale                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap.sh`                        | 532-545 (#199 comment block)                     | Move to `docs/adr/ADR-006-cli-device-flow-monorepo.md` § "Bun setRawMode regressions"                                                        | The exec is now in two places; the rationale belongs in the ADR supplement, not next to every callsite.                                      |
| `bootstrap.sh`                        | 501-510 (`APPSTRATE_NO_LAUNCH`)                  | **Keep**                                                                                                                                     | Still useful for fully-scripted provisioning that wants the binary only.                                                                     |
| `apps/cli/src/commands/install.ts`    | 134-138 (nonInteractive comment)                 | Update to reflect new closed-by-default semantic                                                                                             | The comment claims `nonInteractive` means "fail fast on port conflicts + defaults" — true, but now also means "closed-by-default bootstrap". |
| `apps/cli/src/commands/install.ts`    | `clack.note` in `resolveTier` line 580-585       | **Keep**                                                                                                                                     | The `--yes: Tier 3 selected automatically` notice still fires, just less often (only when actually `--yes`).                                 |
| `apps/cli/src/commands/install.ts`    | 524-530 in `bootstrap.sh` exec rationale         | Drop the part about "User who genuinely wants the interactive prompts can run `appstrate install` directly after bootstrap drops the binary" | That's now the **default**, no longer a workaround — the comment is obsolete.                                                                |
| `apps/cli/src/lib/install/secrets.ts` | 168-184 (`closedModeFooter`)                     | Refactor: branch on `(email, token, neither)` instead of `(email, !email)`                                                                   | The footer logic gets one more case (token), cleanest as a switch.                                                                           |
| `examples/self-hosting/AUTH_MODES.md` | (whole file)                                     | Add a section on `AUTH_BOOTSTRAP_TOKEN` redemption flow                                                                                      | New env var, new code path, needs docs.                                                                                                      |
| `apps/cli/test/install.test.ts`       | 1072-1180 (resolveBootstrapEmail tests)          | Add 2 new test cases: `(nonInteractive=true, no env, fresh, tier≥1) → returns bootstrapToken` ; `--yes` end-to-end → token written to .env   | Existing tests cover env-var path; the new closed-default needs explicit coverage.                                                           |
| `apps/cli/test/install.test.ts`       | "regression suite for #199" tests (lines 90-180) | **Keep**                                                                                                                                     | Still valid — `--yes` path still bypasses clack prompts.                                                                                     |
| `scripts/lib/`                        | (currently `module-openapi.ts` only)             | **No change**                                                                                                                                | Not touched.                                                                                                                                 |

**Code that becomes definitively dead and can be deleted:**

- The `#199 setRawMode regression` workaround comment (lines 522-545 of `bootstrap.sh`) — the workaround stays, but the comment block is moved to ADR-006 and replaced with a 2-line pointer. Net: ~25 lines removed from the hot path.
- Nothing else qualifies as outright dead code. The two-step pattern is additive — every existing branch (env override, upgrade, Tier 0, dual-install) still fires.

## Test plan

Mapping to the issue's acceptance criteria:

| Test                                                                          | Type             | New / existing         | Location                                                               |
| ----------------------------------------------------------------------------- | ---------------- | ---------------------- | ---------------------------------------------------------------------- |
| `curl \| bash` (mocked TTY stdout) drops binary, no exec                      | Shell            | New                    | `scripts/test/bootstrap-two-step.bats` (new dir)                       |
| `curl \| bash -s -- --yes` execs install with `--yes`                         | Shell            | New                    | same                                                                   |
| `curl \| bash` (no TTY) treats as `--yes`                                     | Shell            | New                    | same                                                                   |
| `APPSTRATE_AUTO_INSTALL=1 curl \| bash` execs (legacy)                        | Shell            | New                    | same                                                                   |
| `APPSTRATE_NO_LAUNCH=1` skips entirely                                        | Shell            | New (regression)       | same                                                                   |
| `resolveBootstrapEmail` non-interactive Tier ≥ 1 fresh → `{ bootstrapToken }` | Unit             | New                    | `apps/cli/test/install.test.ts`                                        |
| `resolveBootstrapEmail` non-interactive Tier 0 → `{}` (open)                  | Unit             | New                    | same                                                                   |
| `generateEnvForTier` with `bootstrapToken` writes `AUTH_BOOTSTRAP_TOKEN`      | Unit             | New                    | `apps/cli/test/secrets.test.ts` (does it exist? — verify, else create) |
| `renderEnvFile` token-mode footer                                             | Unit             | New                    | same                                                                   |
| `POST /api/auth/bootstrap/redeem` happy path                                  | Integration      | New                    | `apps/api/test/integration/auth-bootstrap-token.test.ts`               |
| Token redeem rejected when already redeemed                                   | Integration      | New                    | same                                                                   |
| Frontend `/claim` page renders when `bootstrapTokenPending`                   | E2E (Playwright) | New (optional — defer) | `apps/web/src/pages/test/`                                             |

Existing tests to verify still pass: all `resolveTier --yes` regression tests (#199 family), all `resolveBootstrapEmail` env-var tests (#228), all `dual-install-check` tests (#249).

## Docs updates

1. `examples/self-hosting/README.md` — change `curl … \| bash` invocation example to mention the new two-step flow.
2. `examples/self-hosting/AUTH_MODES.md` — new section "Bootstrap token redemption (unattended installs)".
3. `website/content/docs/get-started/install.mdx` — update the one-liner and add a "what happens next" note (run `appstrate install`).
4. `website/content/docs/get-started/quickstart.mdx` — same update.
5. `website/content/docs/self-hosting/docker-compose.mdx` — line 6's reference to "picks a tier interactively" still applies (the interactive picker now fires from `appstrate install` instead of the bootstrap shell — outcome identical).
6. `website/content/docs/self-hosting/troubleshooting.mdx` — add an entry for "I ran `curl … | bash` and nothing happened" (it dropped the binary, run `appstrate install` next).
7. `apps/api/src/modules/README.md` — no change (modules unaffected).
8. `CLAUDE.md` (root + appstrate/) — add `AUTH_BOOTSTRAP_TOKEN` to the env table.
9. `docs/adr/ADR-006-cli-device-flow-monorepo.md` — add supplement "§ Two-step install + Bun setRawMode regression backstory" with the comment block from `bootstrap.sh`.

## Migration / rollout

**No data migration needed.** Existing installs are untouched — they have an `.env` with either `AUTH_BOOTSTRAP_OWNER_EMAIL` set (closed) or unset (open). Re-running `appstrate install` on an existing instance hits the upgrade path in `mergeEnv` which preserves whatever auth keys are already set (verified at `install.ts:242`).

**Rollout sequence**:

1. Land Edits 5/6/7 (CLI-only, additive — new optional field, new env var emission, new footer branch). No behaviour change yet.
2. Land Edit 8 (platform-side `/api/auth/bootstrap/redeem` route + Zod env entry). Still no behaviour change for existing users.
3. Land Edits 9/10 (frontend claim page). Still dormant — `bootstrapTokenPending` is always false until step 4.
4. Land Edits 1/2/3/4 (bootstrap.sh + install.ts default flip). User-visible change ships here.
5. Update docs (steps 1-9 of "Docs updates" above) in the same PR as step 4 so the docs match the binary on `get.appstrate.dev`.
6. Tag a new alpha release. The `publish-installer.yml` workflow rewrites `__APPSTRATE_VERSION__` in `bootstrap.sh` and uploads to `get.appstrate.dev`.

**Backward compat for users still on old `bootstrap.sh`**: zero — they pinned a version, they get the version they pinned. The CLI binary versions move forward independently.

## Risks

| Risk                                                                                                                                 | Likelihood | Mitigation                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users copy-paste old "curl \| bash and it just works" tutorials, hit the new two-step, get confused                                  | Medium     | Add a clear "next step" in the bootstrap output (Edit 1). Update the most-cited tutorials (docs + blog posts in `website/content/blog/*.mdx` reference the one-liner).                                                |
| Bootstrap token leaks (printed to stdout, ends up in CI log)                                                                         | Low–Medium | Single-use semantics + 24h TTL on the token. Document that anyone who can read the install log can claim the instance — this is no worse than the current "anyone with the URL can sign up" failure mode it replaces. |
| `--yes` users in CI now get closed-by-default but never see the printed token                                                        | Medium     | Token is also written to `<dir>/.env` as `AUTH_BOOTSTRAP_TOKEN=…` — operator can read it via SSH afterwards. Plus a `appstrate bootstrap-token --regenerate` CLI command (small follow-up, can defer).                |
| Bun bug eventually fixed upstream → two-step becomes "less magical" without a need                                                   | Low        | Two-step is SOTA on its own merits (Supabase, Vercel, Railway, gh CLI all ship it). Keep `APPSTRATE_AUTO_INSTALL=1` as the escape hatch for users who want the all-in-one back.                                       |
| `nonInteractive` detection in `install.ts:138` is now load-bearing for closed-default — a regression there flips back to silent open | Medium     | Add an integration test that asserts `nonInteractive=true && tier≥1 && fresh && !env → AUTH_BOOTSTRAP_TOKEN in .env`. Property: never `nonInteractive && !env-override → open`.                                       |

## Effort estimate

| Phase                  | Files touched                 | LOC              | Effort      |
| ---------------------- | ----------------------------- | ---------------- | ----------- |
| CLI-side (Edits 1-7)   | 3                             | ~80 net add      | 0.5 day     |
| Platform-side (Edit 8) | 3 (env, route, auth pipeline) | ~150 add         | 1 day       |
| Frontend (Edits 9-10)  | 2                             | ~120 add         | 0.5 day     |
| Tests                  | 4-5 files                     | ~250 add         | 0.5 day     |
| Docs                   | 9 files                       | small edits      | 0.5 day     |
| **Total**              | **~20 files**                 | **~600 LOC net** | **~3 days** |

## Out of scope (follow-ups, not blocking)

- ASCII banner Layer 3 (#344) — useful belt-and-suspenders but doesn't block this PR. Track as #344 follow-up.
- Homebrew tap / npm distribution channels — separate decision (see prior conversation), independent track.
- Rotating bootstrap tokens via `appstrate bootstrap-token --regenerate` — defer until first user reports a leaked token.
- Telemetry on which installer path users actually take (dropping vs auto-install) — useful but not a launch blocker.
