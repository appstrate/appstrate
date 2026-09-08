// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * No tables to truncate: this module owns a database of its own
 * (`EE_DATABASE_URL`), so none of its tables live in the platform schema the
 * harness truncates. `test/helpers/db.ts` clears the `ee_*` tables instead.
 */
export default [] as const;
