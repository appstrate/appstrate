// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapters for tests, whose transparent egress plane (#779) binds
 * ephemeral loopback ports instead of the machine's real 53/443/80: a test
 * must neither squat a port a developer's local service holds nor depend on
 * it being free.
 *
 * Tests that construct the adapter call {@link createHermeticProcessAdapter};
 * tests that go through the registry (`bootIntegrations`, `runConnectOnce`)
 * set `INTEGRATION_RUNTIME_ADAPTER` to {@link HERMETIC_PROCESS_ADAPTER_ID},
 * registered here on import. The adapter itself still reports id `"process"`.
 */

import { createProcessIntegrationRuntimeAdapter } from "../../integration-runtime-adapter-process.ts";
import {
  registerIntegrationRuntimeAdapter,
  type IntegrationRuntimeAdapter,
} from "../../integration-runtime-adapter.ts";

type ProcessAdapterOptions = NonNullable<
  Parameters<typeof createProcessIntegrationRuntimeAdapter>[0]
>;

export function createHermeticProcessAdapter(
  options: Omit<ProcessAdapterOptions, "transparentPlane"> = {},
): IntegrationRuntimeAdapter {
  return createProcessIntegrationRuntimeAdapter({
    ...options,
    transparentPlane: { ports: { dns: 0, tls: 0, http: 0 } },
  });
}

export const HERMETIC_PROCESS_ADAPTER_ID = "process-hermetic-test";

registerIntegrationRuntimeAdapter({
  id: HERMETIC_PROCESS_ADAPTER_ID,
  create: () => createHermeticProcessAdapter(),
});
