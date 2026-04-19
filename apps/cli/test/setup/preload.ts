// SPDX-License-Identifier: Apache-2.0

/**
 * Test preload — runs before every `bun test` file.
 *
 * Sets `APPSTRATE_CLI_NO_OPEN=1` so the production `open()` call in
 * `commands/login.ts` is a no-op during tests. Primary defense is
 * dependency injection (`LoginDeps.openUrl`), but any suite that
 * forgets the wrapper would still pop real browser tabs — this env
 * var is the belt-and-suspenders that catches copy-paste misses.
 */

process.env.APPSTRATE_CLI_NO_OPEN = "1";
