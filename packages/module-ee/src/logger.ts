// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { createLogger } from "@appstrate/core/logger";

export const logger = createLogger(process.env.LOG_LEVEL ?? "info");
