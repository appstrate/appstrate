// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isSubscriptionEngine } from "../src/subscription-engines.ts";

// Core now owns only the engine VOCABULARY + the pure predicate — the
// provider→engine resolution (subscriptionEngineForProvider) reads the
// model-provider registry and lives in apps/api (see
// apps/api/test/unit/model-providers-registry.test.ts). There is no mutable
// engine registry in core anymore.

describe("isSubscriptionEngine", () => {
  it("is true for the vendor-binary engines, false for pi", () => {
    expect(isSubscriptionEngine("claude")).toBe(true);
    expect(isSubscriptionEngine("codex")).toBe(true);
    expect(isSubscriptionEngine("pi")).toBe(false);
  });
});
