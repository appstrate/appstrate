// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `provider_upload`'s manifest gating + capability
 * resolution. Covers:
 *
 *   - The factory returns `[]` (tool not registered) when no
 *     provider declares `uploadProtocols`.
 *   - The `providerId` and `uploadProtocol` enums are restricted to
 *     the union of declared capabilities.
 *   - Unknown protocol identifiers in a manifest are filtered out
 *     defensively.
 */

import { describe, it, expect } from "bun:test";
import type { Bundle, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import { readProviderUploadCapabilities } from "../mcp/provider-upload-extension.ts";

function makeBundle(providers: Array<{ name: string; uploadProtocols?: unknown }>): {
  bundle: Bundle;
  refs: Array<{ name: string; version: string }>;
} {
  const packages = new Map();
  for (const p of providers) {
    const identity = `${p.name}@1.0.0` as PackageIdentity;
    packages.set(identity, {
      identity,
      manifest: {
        name: p.name,
        version: "1.0.0",
        type: "provider",
        definition: {
          authMode: "oauth2",
          ...(p.uploadProtocols !== undefined ? { uploadProtocols: p.uploadProtocols } : {}),
        },
      },
      files: new Map(),
      integrity: "" as never,
    });
  }
  const bundle = {
    bundleFormatVersion: "1.0",
    root: "@root/agent@1.0.0" as PackageIdentity,
    packages,
    integrity: "" as never,
  } as Bundle;
  const refs = providers.map((p) => ({ name: p.name, version: "^1.0.0" }));
  return { bundle, refs };
}

describe("readProviderUploadCapabilities", () => {
  it("returns an empty map when no provider declares uploadProtocols", () => {
    const { bundle, refs } = makeBundle([
      { name: "@test/no-upload-1" },
      { name: "@test/no-upload-2" },
    ]);
    const caps = readProviderUploadCapabilities(bundle, refs);
    expect(caps.size).toBe(0);
  });

  it("registers protocols declared in definition.uploadProtocols", () => {
    const { bundle, refs } = makeBundle([
      { name: "@test/drive", uploadProtocols: ["google-resumable"] },
      { name: "@test/s3", uploadProtocols: ["s3-multipart"] },
    ]);
    const caps = readProviderUploadCapabilities(bundle, refs);
    expect(caps.get("@test/drive")).toEqual(["google-resumable"]);
    expect(caps.get("@test/s3")).toEqual(["s3-multipart"]);
  });

  it("ignores unknown protocol identifiers (defence-in-depth)", () => {
    const { bundle, refs } = makeBundle([
      { name: "@test/x", uploadProtocols: ["google-resumable", "made-up-protocol"] },
    ]);
    const caps = readProviderUploadCapabilities(bundle, refs);
    expect(caps.get("@test/x")).toEqual(["google-resumable"]);
  });

  it("ignores providers whose uploadProtocols filters down to []", () => {
    const { bundle, refs } = makeBundle([
      { name: "@test/x", uploadProtocols: ["nonexistent"] },
      { name: "@test/y", uploadProtocols: ["another-fake"] },
    ]);
    const caps = readProviderUploadCapabilities(bundle, refs);
    expect(caps.size).toBe(0);
  });

  it("ignores non-array uploadProtocols (malformed manifests)", () => {
    const { bundle, refs } = makeBundle([
      { name: "@test/x", uploadProtocols: "google-resumable" },
      { name: "@test/y", uploadProtocols: { google: true } },
    ]);
    const caps = readProviderUploadCapabilities(bundle, refs);
    expect(caps.size).toBe(0);
  });

  it("supports a provider declaring multiple protocols", () => {
    const { bundle, refs } = makeBundle([
      { name: "@test/multi", uploadProtocols: ["google-resumable", "tus", "s3-multipart"] },
    ]);
    const caps = readProviderUploadCapabilities(bundle, refs);
    expect(caps.get("@test/multi")).toEqual(["google-resumable", "tus", "s3-multipart"]);
  });
});
