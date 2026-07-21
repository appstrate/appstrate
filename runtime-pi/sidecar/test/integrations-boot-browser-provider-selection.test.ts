// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import { requiredBrowserProviders } from "../integrations-boot.ts";

function spec(provider?: "browser-use-cloud" | "process"): IntegrationSpawnSpec {
  return {
    integrationId: `@appstrate/${provider ?? "legacy"}`,
    namespace: provider ?? "legacy",
    sourceKind: "local",
    manifest: { name: "test", version: "1.0.0" },
    spawnEnv: {},
    browser: {
      purpose: "connection-acquisition",
      protocol: "cdp-v1",
      profile: "standard",
      allowedOrigins: ["https://example.com"],
      trustedDriver: true,
      sessionMode: "exportable",
      ...(provider
        ? {
            providerBinding: {
              bindingId: crypto.randomUUID(),
              provider,
              profileRef:
                provider === "browser-use-cloud"
                  ? "018f0c67-98ab-7def-8123-123456789abc"
                  : "process-profile",
              stateVersion: 1,
            },
          }
        : {}),
    },
  };
}

describe("browser provider boot selection", () => {
  it("does not prepare an unrelated operator default when every binding is explicit", () => {
    expect(requiredBrowserProviders([spec("browser-use-cloud")])).toEqual({
      needsDefault: false,
      overrides: ["browser-use-cloud"],
    });
  });

  it("prepares the default only for legacy specs and de-duplicates explicit providers", () => {
    expect(
      requiredBrowserProviders([
        spec(),
        spec("process"),
        spec("browser-use-cloud"),
        spec("process"),
      ]),
    ).toEqual({
      needsDefault: true,
      overrides: ["browser-use-cloud", "process"],
    });
  });
});
