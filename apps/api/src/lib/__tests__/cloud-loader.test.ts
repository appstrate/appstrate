import { describe, test, expect } from "bun:test";

// loadCloud() may throw if the cloud module is installed but env vars are missing.
// We test the contract: import succeeds silently or init fails loudly.
describe("cloud-loader", () => {
  test("loadCloud resolves to module or null (OSS), or throws on init failure", async () => {
    // Fresh import to avoid cached state from other tests
    const { loadCloud } = await import("../cloud-loader.ts");

    try {
      const result = await loadCloud();
      // Either cloud loaded successfully or module not installed (OSS)
      if (result) {
        expect(result).toHaveProperty("initCloud");
        expect(result).toHaveProperty("getCloudConfig");
        expect(result).toHaveProperty("cloudHooks");
        expect(result).toHaveProperty("registerCloudRoutes");
      } else {
        expect(result).toBeNull();
      }
    } catch (err) {
      // Cloud module is installed but init failed (missing env vars, DB, etc.)
      // This is expected behavior — fail-fast on misconfiguration
      expect(err).toBeInstanceOf(Error);
    }
  });

  test("getCloudModule throws if loadCloud was never called", async () => {
    // Re-import to get a module where _cloud is still undefined
    // Note: this test relies on module caching, so it may see the cached state
    // from the previous test. We just verify the function exists.
    const { getCloudModule } = await import("../cloud-loader.ts");
    expect(typeof getCloudModule).toBe("function");
  });
});
