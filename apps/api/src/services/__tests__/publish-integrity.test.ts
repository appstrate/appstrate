import { describe, test, expect } from "bun:test";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import { prepareManifestForPublish } from "@appstrate/core/dependencies";

/**
 * Proves that when both createVersionFromDraft and publishPackage produce ZIPs
 * from the same enriched manifest, their integrity hashes match.
 *
 * Before the fix, createVersionFromDraft did NOT call prepareManifestForPublish,
 * so the version ZIP had no dependencies, while publishPackage rebuilt the
 * ZIP with them — causing integrity mismatches.
 */

const baseManifest = {
  name: "@test/my-flow",
  description: "A test flow",
  type: "flow",
};

const scope = "test";
const name = "my-flow";
const version = "1.0.0";

const deps = {
  skills: { "@test/skill-a": "^1.0.0" },
};

function buildZip(manifest: Record<string, unknown>, content: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(content),
  };
  return zipArtifact(entries, 6);
}

describe("publish integrity", () => {
  test("enriched local ZIP matches what publishPackage would produce", () => {
    const content = "# Hello world";

    // createVersionFromDraft path (after fix): enriches manifest with prepareManifestForPublish
    const localManifest = prepareManifestForPublish(
      { ...baseManifest, version },
      scope,
      name,
      version,
      deps,
    );
    const localZip = buildZip(localManifest, content);
    const localIntegrity = computeIntegrity(localZip);

    // publishPackage path: also calls prepareManifestForPublish with same inputs
    const publishManifest = prepareManifestForPublish(
      { ...baseManifest, version },
      scope,
      name,
      version,
      deps,
    );
    const publishZip = buildZip(publishManifest, content);
    const publishIntegrity = computeIntegrity(publishZip);

    expect(localIntegrity).toBe(publishIntegrity);
  });

  test("two ZIPs with same enriched manifest produce identical integrity", () => {
    const content = "# Hello world";

    const enrichedManifest = prepareManifestForPublish(
      { ...baseManifest, version },
      scope,
      name,
      version,
      deps,
    );

    const zip1 = buildZip(enrichedManifest, content);
    const zip2 = buildZip(enrichedManifest, content);

    expect(computeIntegrity(zip1)).toBe(computeIntegrity(zip2));
  });

  test("null dependencies produces same manifest as base", () => {
    const manifest = { ...baseManifest, version };
    const prepared = prepareManifestForPublish(manifest, scope, name, version, null);

    expect(prepared).toEqual({
      name: `@${scope}/${name}`,
      description: baseManifest.description,
      type: baseManifest.type,
      version,
    });
    expect("dependencies" in prepared).toBe(false);
  });
});
