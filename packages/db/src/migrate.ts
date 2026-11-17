// SPDX-License-Identifier: Apache-2.0

import { applyCoreMigrations } from "./core-migrations.ts";
import { logger } from "./logger.ts";

const url = process.env["DATABASE_URL"];
if (!url) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

logger.info("Running migrations...");
await applyCoreMigrations(url);
logger.info("Migrations complete");
