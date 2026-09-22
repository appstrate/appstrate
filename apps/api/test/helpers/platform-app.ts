// SPDX-License-Identifier: Apache-2.0

import { setPlatformApp } from "../../src/lib/platform-app.ts";
import { getTestApp } from "./app.ts";

/**
 * Register the SHARED test app as the platform app, for anything that reads the
 * mounted route table. `setPlatformApp` is module-level state in a one-process
 * runner, so a stand-in app registered here would answer for every file loaded
 * after this one.
 */
export function registerTestPlatformApp(): void {
  setPlatformApp(getTestApp());
}
