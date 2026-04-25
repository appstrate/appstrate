# Upgrading the Appstrate CLI

Two install channels ship the `appstrate` binary today. Each has its own upgrade
path; mixing them on the same machine can leave you with two binaries silently
shadowing each other on `$PATH`. This page is the reference matrix.

> [!TIP]
> **Quick check:** run `appstrate doctor` to see every `appstrate` binary on
> your `$PATH`, the channel that produced each one, and which one is currently
> winning resolution.

## Channel matrix

| Channel            | Install                                        | Upgrade                   | Uninstall                    | Notes                                                                                                                                                 |
| ------------------ | ---------------------------------------------- | ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **curl**           | `curl -fsSL https://get.appstrate.dev \| bash` | `appstrate self-update`   | `rm $(command -v appstrate)` | Signed binary from the GitHub Release. Verifies the SHA-256 + minisign signature on every install/update. Default install dir: `~/.local/bin`.        |
| **bun (npm)**      | `bun install -g appstrate`                     | `bun update -g appstrate` | `bun remove -g appstrate`    | npm package. The `bun` runtime is the package manager here — Bun's tag for this binary may lag the curl release by a few minutes after a release tag. |
| **bunx (one-off)** | `bunx appstrate <subcmd>`                      | n/a (always pulls latest) | n/a                          | Ephemeral. Each invocation downloads + runs a fresh copy. Useful for CI.                                                                              |

> Homebrew is **not** an officially supported channel. If a third party publishes
> a tap, neither `appstrate self-update` nor the bootstrap pre-check will know
> about it — manage that install via `brew` itself.

## Choosing a channel

| If you want…                                                    | Use      |
| --------------------------------------------------------------- | -------- |
| The fastest install + signed binary + first-class `self-update` | **curl** |
| To keep all your CLIs in one package manager (`bun update -g`)  | **bun**  |
| To run once in CI without persisting                            | **bunx** |

For most users, the curl channel is the default recommendation: it ships a
single statically-linked binary with cryptographic provenance (minisign
signature on `checksums.txt`, see `docs/adr/ADR-006-cli-device-flow-monorepo.md`)
and the in-place `self-update` flow works without involving any other tool.

## Upgrading

### `appstrate self-update` (curl channel only)

```sh
appstrate self-update             # latest release
appstrate self-update --release 1.2.3   # pin a specific version
appstrate self-update --force     # reinstall the same version
```

The command:

1. Reads the build-time install-source stamp on the running binary (see
   `apps/cli/src/lib/install-source.ts`).
2. If the binary was produced by the **bun** channel, it exits 1 with a
   `bun update -g appstrate` hint and does nothing — that channel owns its
   own upgrades.
3. If the binary has no stamp (built from source / copied), it exits 1 with
   a diagnostic. Re-install via curl to enable in-place upgrades.
4. Otherwise: resolves the target version (default = latest from the
   GitHub Releases API), downloads the asset + signed checksums + minisign
   signature, verifies the signature against the same pubkey baked into
   `scripts/bootstrap.sh`, verifies the SHA-256, and atomically renames the
   new binary over `process.execPath`.

The verification posture is identical to the curl bootstrap — `minisign`
must be on `$PATH`. There is no `--skip-verify` flag.

### `bun update -g appstrate` (bun channel)

This is the canonical npm package manager command — Appstrate adds nothing
on top. Bun handles dependency resolution + the binary symlink in
`~/.bun/install/global/bin/`.

If you have both a curl install AND an npm install on the same machine,
`bun update -g appstrate` only updates the npm one. Use `appstrate doctor`
to verify which binary you're talking to after the upgrade.

## Diagnosing dual-install

```sh
appstrate doctor
```

Sample output:

```
Found 2 installations of `appstrate` on $PATH:

   ★← /Users/me/.local/bin/appstrate                          [curl]     1.2.3
      /Users/me/.bun/install/global/bin/appstrate             [bun]      1.2.0

    ★ = running CLI
    ← = first on $PATH (resolved when you type 'appstrate')

  Multiple installations detected.
  Different channels are present. To remove the channel that is NOT
  winning resolution:
    • bun channel → bun remove -g appstrate
```

`doctor` walks `$PATH`, fork-execs each binary's hidden
`__install-source` subcommand to read its stamped channel, and prints a
report with cleanup hints scoped to whichever channel is NOT winning
resolution. `--json` emits a machine-readable report for scripts.

### Why dual-install matters

When two `appstrate` binaries are on `$PATH`, the order of directories in
`$PATH` decides which one is exec'd. `appstrate self-update` only ever
updates the one it's running as, so the other one drifts. After enough
drift the two binaries can:

- Disagree on `--version`.
- Disagree on the API contract version (`Appstrate-Version` header).
- Use different on-disk paths for the keyring / config / TOML profiles.

The bootstrap installer refuses to write the curl binary if another
`appstrate` is already on `$PATH` at a different path — see
[the pre-check](#bootstrap-pre-check) below. The runtime CLI also surfaces
a one-time warning the first time it detects the dual-install state, so
you don't miss the case where you installed via npm AFTER bootstrapping.

### Cleanup

Once `appstrate doctor` has identified which install you want to keep,
remove the other one with the channel-specific command:

| Remove a…         | Command                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| curl install      | `rm <path-from-doctor>` (the bootstrap installer copies one binary to one path; nothing else to clean up) |
| bun (npm) install | `bun remove -g appstrate`                                                                                 |
| bunx ephemeral    | (no-op — bunx downloads each run, nothing persists)                                                       |

If you also want to revoke any cached credentials (the curl + bun
binaries share the same keyring), run `appstrate logout` before the
remove.

## Bootstrap pre-check

`scripts/bootstrap.sh` (the body of `https://get.appstrate.dev`) scans
`$PATH` BEFORE downloading the binary. If it finds an existing
`appstrate` at a different path than the install destination, it
refuses non-interactively and prompts `[y/N]` interactively.

Override:

```sh
APPSTRATE_FORCE_DUAL=1 curl -fsSL https://get.appstrate.dev | bash
```

This bypass is intended for users who deliberately want both binaries
side by side (e.g. for testing). Once both are installed, you'll see the
runtime warning on every distinct command until you ack it (or set
`APPSTRATE_NO_DUAL_INSTALL_CHECK=1`).

## Runtime warning

The CLI emits a one-time warning to stderr when it detects more than
one `appstrate` on `$PATH` at distinct realpaths:

```
! Multiple `appstrate` installations detected on $PATH (2 entries):
    /Users/me/.local/bin/appstrate
    /Users/me/.bun/install/global/bin/appstrate
! Run `appstrate doctor` for the full report.
! To upgrade the npm-channel binary: bun update -g appstrate
! Silence this warning: APPSTRATE_NO_DUAL_INSTALL_CHECK=1
```

The warning is acknowledged in
`~/.config/appstrate/dual-install-ack.json` (keyed on the sorted set of
realpaths) so the same set never warns twice. If you add or remove an
install, the warning re-arms automatically.

| Env var                             | Effect                                             |
| ----------------------------------- | -------------------------------------------------- |
| `APPSTRATE_NO_DUAL_INSTALL_CHECK=1` | Silence the runtime warning entirely.              |
| `APPSTRATE_FORCE_DUAL=1`            | Bypass the bootstrap pre-check and install anyway. |

The warning is **not** emitted for `--version`, `--help`, `completion`,
`doctor`, or the hidden `__install-source` subcommand, so scripts that
parse those outputs stay machine-readable.

## I installed both — now what?

1. `appstrate doctor` — see which paths are present and which channel
   each one came from.
2. Decide which channel you want to keep (curl is the default
   recommendation; pick bun if your team manages everything via bun).
3. Run the channel-specific uninstall on the OTHER one (table above).
4. Re-run `appstrate doctor` to confirm the cleanup.
5. Run `appstrate --version` to verify the surviving install reports
   the version you expect.

## See also

- [`docs/adr/ADR-006-cli-device-flow-monorepo.md`](../adr/ADR-006-cli-device-flow-monorepo.md)
  — full design of the CLI distribution model and trust chain.
- [`scripts/bootstrap.sh`](../../scripts/bootstrap.sh) — the curl
  installer, including the dual-install pre-check.
- [`scripts/verify.sh`](../../scripts/verify.sh) — the optional
  audit-then-exec wrapper for users who want to verify the bootstrap
  signature before piping it to bash.
