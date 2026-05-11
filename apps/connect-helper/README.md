# @appstrate/connect-helper

One-shot OAuth helper for connecting personal ChatGPT (Codex) and Claude (Pro / Max) subscriptions to an [Appstrate](https://github.com/appstrate/appstrate) organization.

## Why this exists

The official ChatGPT and Claude Code CLIs use OAuth client_ids that only allowlist `http://localhost:PORT/...` redirect URIs. The Appstrate dashboard cannot host the OAuth callback itself — the providers' authorization servers reject any redirect that isn't loopback. This helper bridges that gap: it runs on the user's machine, binds the loopback port the providers expect, completes the OAuth dance, and ships the resulting credentials back to the Appstrate platform.

The dashboard is the entry point — the user clicks "Connect Claude Pro", the platform mints a short-lived pairing token, and the user copy-pastes a one-line `npx` command.

## Usage

The dashboard generates the exact command — you should not invoke this helper directly outside of that flow.

```sh
# Surfaced by the dashboard, copied verbatim by the user:
npx @appstrate/connect-helper@latest <pairing-token>
```

The helper:

1. Decodes the pairing token (base64url JSON header + random secret).
2. Opens your browser to the provider's authorize page.
3. Receives the OAuth callback on the loopback port the provider expects.
4. POSTs the resulting credentials to the platform URL embedded in the token.
5. Exits.

The platform's pairing token expires 5 minutes after issue and is single-use. If the helper hangs, exits non-zero, or the pairing has expired, regenerate the command from the dashboard.

## Installation

You don't need to install anything — `npx` downloads the package on demand. If you prefer a global install:

```sh
npm install -g @appstrate/connect-helper
appstrate-connect <pairing-token>
```

## Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Success — credentials saved on the platform              |
| 1    | Generic / network / unexpected error                     |
| 2    | Bad pairing token (malformed, expired, already consumed) |
| 3    | OAuth flow cancelled by the user                         |

## Security

- The helper is **stateless** — no config files, no keychain, no persisted state. Tokens live in process memory for the duration of the helper's run, then disappear.
- The pairing token's secret portion is hashed (SHA-256) before storage server-side; the platform never persists the plaintext.
- The token includes the platform URL; the helper rejects HTTP URLs for non-loopback hosts so a tampered token can't downgrade you into a clear-text POST.
- The `npx` invocation downloads the helper from the npm registry. We recommend pinning a version (`@appstrate/connect-helper@1.x.x`) in production setups; the dashboard does this by default.

## License

Apache-2.0. Part of the [Appstrate](https://github.com/appstrate/appstrate) project.
