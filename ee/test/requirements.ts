// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

// Harness requirements (`test/setup/modules.ts`): the package's tables live in
// the platform database, so it needs the harness's real PostgreSQL. Tier-0
// PGlite offers neither postgres.js nor the `DATABASE_URL` it reads at init.

export default { postgres: true } as const;
