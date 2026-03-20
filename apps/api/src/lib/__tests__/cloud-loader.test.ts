import { describe, test, expect } from "bun:test";

// Import directly — @appstrate/cloud does not exist in OSS, so loadCloud() will fallback to null
const { loadCloud, getCloudModule } = await import("../cloud-loader.ts");

describe("cloud-loader", () => {
  test("loadCloud returns null when @appstrate/cloud is not installed", async () => {
    const cloud = await loadCloud();
    expect(cloud).toBeNull();
  });

  test("getCloudModule returns null after loadCloud resolves to null", () => {
    // loadCloud already called above, _cloud is now null (not undefined)
    const cloud = getCloudModule();
    expect(cloud).toBeNull();
  });

  test("loadCloud returns cached result on subsequent calls", async () => {
    const first = await loadCloud();
    const second = await loadCloud();
    expect(first).toBe(second);
    expect(first).toBeNull();
  });
});
