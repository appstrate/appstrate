// SPDX-License-Identifier: Apache-2.0

/**
 * The origin the suite drives, shared by `playwright.config.ts` (baseURL +
 * webServer) and by any helper that has to name it explicitly — Better Auth
 * rejects a sign-up whose `Origin` is not in `TRUSTED_ORIGINS`, so a hard-coded
 * `http://localhost:3000` would 403 the moment `E2E_PORT` moves.
 *
 * `E2E_PORT` exists so a local run can sidestep a developer's own server on
 * 3000. Unset (CI) it resolves to 3000 and nothing changes.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);

export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
