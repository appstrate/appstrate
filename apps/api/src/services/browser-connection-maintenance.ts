// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";

import { logger } from "../lib/logger.ts";
import {
  expireBrowserConnectionAttempts,
  listBrowserAttemptsReadyForProvisioning,
  purgeFinishedBrowserConnectionAttempts,
  recoverStaleBrowserProvisioningAttempts,
} from "./browser-connection-state.ts";
import { provisionBrowserConnectionAttempt } from "./browser-companion.ts";
import { drainBrowserProfileDeletions } from "./browser-profile-deletions.ts";
import { createBrowserConnectRunExecutor } from "./connect/browser-run-launcher.ts";

const SWEEP_INTERVAL_MS = 30_000;
const inFlight = new Set<string>();
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

export async function sweepBrowserConnectionAttempts(): Promise<void> {
  await recoverStaleBrowserProvisioningAttempts();
  await expireBrowserConnectionAttempts();
  await purgeFinishedBrowserConnectionAttempts();
  await drainBrowserProfileDeletions();
  const executor = createBrowserConnectRunExecutor({ timeoutMs: 10 * 60_000 });
  for (const attemptId of await listBrowserAttemptsReadyForProvisioning()) {
    if (inFlight.has(attemptId)) continue;
    inFlight.add(attemptId);
    void provisionBrowserConnectionAttempt(attemptId, executor).finally(() => {
      inFlight.delete(attemptId);
    });
  }
}

export function startBrowserConnectionMaintenance(): void {
  if (maintenanceTimer) return;
  void sweepBrowserConnectionAttempts().catch((error) => {
    logger.warn("Initial browser connection maintenance failed", {
      error: getErrorMessage(error),
    });
  });
  maintenanceTimer = setInterval(() => {
    void sweepBrowserConnectionAttempts().catch((error) => {
      logger.warn("Browser connection maintenance failed", {
        error: getErrorMessage(error),
      });
    });
  }, SWEEP_INTERVAL_MS);
  maintenanceTimer.unref?.();
}

export function stopBrowserConnectionMaintenance(): void {
  if (!maintenanceTimer) return;
  clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}
