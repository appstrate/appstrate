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
 *  - `APPSTRATE_API_KEY` / `APPSTRATE_INSTANCE` / `APPSTRATE_ORG_ID` /
 *    `APPSTRATE_SPACE_ID` deleted — `appstrate api` and `appstrate run`
 *    read them as a headless credential, so a value exported in the
 *    developer's shell would send a suite's requests to a real instance
 *    with a real key. A test that sets one deletes it afterwards.
 */

process.env.APPSTRATE_CLI_NO_OPEN = "1";
process.env.NO_COLOR = "1";
delete process.env.APPSTRATE_API_KEY;
delete process.env.APPSTRATE_INSTANCE;
delete process.env.APPSTRATE_ORG_ID;
delete process.env.APPSTRATE_SPACE_ID;
Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
