// SPDX-License-Identifier: Apache-2.0

import { createLogger } from "@appstrate/core/logger";

export const logger = createLogger(process.env.LOG_LEVEL ?? "info");
