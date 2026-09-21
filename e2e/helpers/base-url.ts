// SPDX-License-Identifier: Apache-2.0

/**
 * The origin the suite drives, shared by `playwright.config.ts` (baseURL +
 * webServer) and by any helper that has to name it explicitly — Better Auth
 * rejects a sign-up whose `Origin` is not in `TRUSTED_ORIGINS`, so a hard-coded
 * `http://localhost:3000` would 403 the moment `E2E_PORT` moves.
 *
 * `E2E_PORT` moves that origin off 3000 when something else already holds the
 * port. It is a convenience, NOT a safety boundary: what keeps the suite out
 * of a developer's `./data/pglite` and `./data/storage` is
 * `reuseExistingServer: !!process.env.CI` in `playwright.config.ts`, which
 * forces Playwright to start its own server (and therefore apply the pinned
 * `PGLITE_DATA_DIR` / `FS_STORAGE_PATH`) on every local run. Unset it resolves
 * to 3000 and nothing changes.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);

export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
