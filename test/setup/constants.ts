// SPDX-License-Identifier: Apache-2.0

/**
 * Shared constants for the test harness — container names and credentials
 * used by the root preload and by module migration helpers. Kept in one
 * place so renames and credential changes happen in a single file.
 *
 * Values must match what `test/setup/docker-compose.test.yml` declares.
 */

export const TEST_POSTGRES_CONTAINER = "setup-postgres-test-1";
export const TEST_MINIO_CONTAINER = "setup-minio-test-1";
export const TEST_DB_NAME = "appstrate_test";
export const TEST_DB_USER = "test";
