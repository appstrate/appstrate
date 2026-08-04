// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { resolveDockerPlatformApiUrl } from "../../../src/services/orchestrator/platform-api-url.ts";

describe("DockerOrchestrator platform API URL", () => {
  it("uses the configured stable service URL without requiring Docker discovery", async () => {
    let discoveryCalls = 0;
    const result = await resolveDockerPlatformApiUrl({
      configuredUrl: "http://appstrate:3000",
      port: 3000,
      detectPlatformNetwork: async () => {
        discoveryCalls += 1;
        return { hostname: "ephemeral-replica" };
      },
    });

    expect(result).toBe("http://appstrate:3000");
    expect(discoveryCalls).toBe(0);
  });

  it("uses Docker discovery when no stable URL is configured", async () => {
    await expect(
      resolveDockerPlatformApiUrl({
        port: 3000,
        detectPlatformNetwork: async () => ({ hostname: "appstrate-1" }),
      }),
    ).resolves.toBe("http://appstrate-1:3000");
  });

  it("falls back to the host bridge when Docker discovery finds no platform", async () => {
    await expect(
      resolveDockerPlatformApiUrl({
        port: 3000,
        detectPlatformNetwork: async () => null,
      }),
    ).resolves.toBe("http://host.docker.internal:3000");
  });
});
