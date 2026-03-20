import { describe, test, expect } from "bun:test";

const { loadCloud, getCloudModule } = await import("../cloud-loader.ts");

// @appstrate/cloud may or may not be installed (bun link for Cloud dev).
// These tests verify the loader contract regardless of module presence.
const cloud = await loadCloud();
const isCloudInstalled = cloud !== null;

describe("cloud-loader", () => {
  test("loadCloud resolves without throwing", async () => {
    const result = await loadCloud();
    if (isCloudInstalled) {
      expect(result).not.toBeNull();
    } else {
      expect(result).toBeNull();
    }
  });

  test("getCloudModule returns consistent result after loadCloud", () => {
    const result = getCloudModule();
    if (isCloudInstalled) {
      expect(result).not.toBeNull();
    } else {
      expect(result).toBeNull();
    }
  });

  test("loadCloud returns cached result on subsequent calls", async () => {
    const first = await loadCloud();
    const second = await loadCloud();
    expect(first).toBe(second);
  });

  test("cloud module exports expected interface when loaded", async () => {
    if (!isCloudInstalled) return;
    expect(cloud).toHaveProperty("initCloud");
    expect(cloud).toHaveProperty("getCloudConfig");
    expect(cloud).toHaveProperty("cloudHooks");
    expect(cloud).toHaveProperty("registerCloudRoutes");
  });
});
