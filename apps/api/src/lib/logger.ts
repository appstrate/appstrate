import { createLogger } from "@appstrate/core/logger";
import { getEnv } from "@appstrate/env";

export const logger = createLogger(getEnv().LOG_LEVEL);
