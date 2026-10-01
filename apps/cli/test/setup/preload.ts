// SPDX-License-Identifier: Apache-2.0

/**
 * Test preload — runs before every `bun test` file.
 *
 * Forces a deterministic non-interactive environment so tests behave
 * identically whether launched from a TTY shell or CI:
 *  - `APPSTRATE_CLI_NO_OPEN=1` — `defaultOpenUrl()` in `commands/login.ts`
 *    is a no-op (no real browser tabs).
 *  - `NO_COLOR=1` — `detectColor()` in `commands/openapi.ts` returns false,
 *    so formatters emit plain strings that match the expected snapshots.
 *  - `process.stdin.isTTY = false` — the `askText` / `confirm` guards in
 *    `lib/ui.ts` throw immediately instead of blocking on clack.
 */

process.env.APPSTRATE_CLI_NO_OPEN = "1";
process.env.NO_COLOR = "1";
Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
