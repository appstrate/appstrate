// SPDX-License-Identifier: Apache-2.0

/**
 * Records `onCredentialNeedsReconnection` through a module registered with `loadModulesFromInstances`.
 * The announcement is fire-and-forget, so assertions poll with {@link until}; call
 * `restoreDiscoveredModules()` in `afterAll`.
 */

import type { AppstrateModule, CredentialNeedsReconnectionParams } from "@appstrate/core/module";
import { loadModulesFromInstances, resetModules } from "../../src/lib/modules/module-loader.ts";

export const announced: CredentialNeedsReconnectionParams[] = [];

/** Empty `announced` and (re)install the recording module. */
export async function installDeathSpy(): Promise<void> {
  announced.length = 0;
  resetModules();
  const mod: AppstrateModule = {
    manifest: { id: "death-spy", name: "Death Spy", version: "1.0.0" },
    async init() {},
    events: { onCredentialNeedsReconnection: (params) => void announced.push(params) },
  };
  await loadModulesFromInstances([mod], {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => async () => {},
    getOrgOwnerEmails: async () => [],
    getOrgMembers: async () => [],
    getOrgName: async () => null,
    services: {} as never,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate` holds. */
export async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("announcement never arrived");
}

/** Called once, after a test's last write: a stray extra announcement has time to land. */
export const settle = () => sleep(200);
