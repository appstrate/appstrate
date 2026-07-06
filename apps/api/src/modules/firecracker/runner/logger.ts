// SPDX-License-Identifier: Apache-2.0

/**
 * Logger for the `appstrate-runner` daemon and the FirecrackerOrchestrator
 * engine it drives.
 *
 * The platform logger (apps/api/src/lib/logger.ts) reads its level from
 * `@appstrate/env`, whose schema requires BETTER_AUTH_SECRET /
 * CONNECTION_ENCRYPTION_KEY / UPLOAD_SIGNING_SECRET — secrets that make no
 * sense on a bare KVM host. The daemon must boot with ONLY the
 * FIRECRACKER_RUNNER_* variables, so its logging cannot depend on that
 * schema. This wraps the same core pino JSON logger, reading only the
 * optional LOG_LEVEL (default `info`) straight from the environment.
 *
 * Same call signature (`logger.info(msg, data?)`) as the platform logger,
 * so daemon-closure call sites are identical.
 */

import { createLogger } from "@appstrate/core/logger";

export const logger = createLogger(process.env.LOG_LEVEL ?? "info");
