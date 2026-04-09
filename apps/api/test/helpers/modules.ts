// SPDX-License-Identifier: Apache-2.0

import type { AppstrateModule } from "../../src/lib/modules/types.ts";

/** Create a minimal mock module for testing. */
export function createMockModule(
  overrides: Partial<AppstrateModule> & { id?: string } = {},
): AppstrateModule {
  const { id, ...rest } = overrides;
  return {
    manifest: { id: id ?? "test-mock", name: "Test Mock", version: "0.0.1" },
    async init() {},
    ...rest,
  };
}
