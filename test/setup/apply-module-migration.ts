// SPDX-License-Identifier: Apache-2.0

/**
 * Helper for the test preload to apply a module-owned SQL migration.
 *
 * Pipes the file contents to psql inside the test postgres container via
 * a single `docker exec -i`, so there's no intermediate `docker cp` and no
 * temp file left behind in the container.
 */
import { readFileSync } from "fs";
import { TEST_DB_NAME, TEST_DB_USER, TEST_POSTGRES_CONTAINER } from "./constants.ts";

export function applyModuleMigration(migrationPath: string): void {
  const sql = readFileSync(migrationPath, "utf8");

  const apply = Bun.spawnSync(
    [
      "docker",
      "exec",
      "-i",
      TEST_POSTGRES_CONTAINER,
      "psql",
      "-U",
      TEST_DB_USER,
      "-d",
      TEST_DB_NAME,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { stdin: Buffer.from(sql), stdout: "pipe", stderr: "pipe" },
  );
  if (apply.exitCode !== 0) {
    throw new Error(
      `Migration ${migrationPath} failed:\nstderr: ${apply.stderr.toString()}\nstdout: ${apply.stdout.toString()}`,
    );
  }
}
