// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for runtime-image pair coherence — the two checks that make a
 * mismatched `PI_IMAGE` / `SIDECAR_IMAGE` couple visible instead of letting it
 * surface as an opaque upstream error mid-run (#1195, #1200).
 *
 * The boot gate is the one with teeth, so most of the surface here is about
 * what it must NOT reject: the zero-config dev pair, a matching release pin,
 * a registry host carrying a port, a digest pin. The revision check is
 * advisory and asserted on what it compares, not on log output.
 */

import { describe, it, expect } from "bun:test";
import {
  parseImageRef,
  findRuntimeImageTagMismatch,
  assertRuntimeImagePairPinned,
  warnOnRuntimeImageRevisionDrift,
  OCI_REVISION_LABEL,
} from "../../../src/services/orchestrator/runtime-image-pair.ts";

describe("parseImageRef", () => {
  it("defaults a bare repository to :latest", () => {
    expect(parseImageRef("appstrate-pi")).toEqual({
      repository: "appstrate-pi",
      tag: "latest",
      digest: undefined,
    });
  });

  it("splits an explicit tag", () => {
    expect(parseImageRef("ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49")).toEqual({
      repository: "ghcr.io/appstrate/appstrate-pi",
      tag: "1.0.0-beta.49",
      digest: undefined,
    });
  });

  it("does not mistake a registry port for a tag", () => {
    expect(parseImageRef("localhost:5000/appstrate-pi")).toEqual({
      repository: "localhost:5000/appstrate-pi",
      tag: "latest",
      digest: undefined,
    });
    expect(parseImageRef("localhost:5000/appstrate-pi:dev")).toEqual({
      repository: "localhost:5000/appstrate-pi",
      tag: "dev",
      digest: undefined,
    });
  });

  it("leaves a digest-pinned ref without an invented tag", () => {
    const ref = `ghcr.io/appstrate/appstrate-pi@sha256:${"a".repeat(64)}`;
    expect(parseImageRef(ref)).toEqual({
      repository: "ghcr.io/appstrate/appstrate-pi",
      tag: undefined,
      digest: `sha256:${"a".repeat(64)}`,
    });
  });
});

describe("findRuntimeImageTagMismatch", () => {
  it("accepts the zero-config dev pair (both implicitly :latest)", () => {
    expect(findRuntimeImageTagMismatch("appstrate-pi", "appstrate-sidecar")).toBeNull();
  });

  it("accepts a release pair pinned to the same tag", () => {
    expect(
      findRuntimeImageTagMismatch(
        "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49",
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.49",
      ),
    ).toBeNull();
  });

  it("reports a pair pinned one release apart", () => {
    expect(
      findRuntimeImageTagMismatch(
        "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49",
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.48",
      ),
    ).toEqual({
      piImage: "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49",
      sidecarImage: "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.48",
      piTag: "1.0.0-beta.49",
      sidecarTag: "1.0.0-beta.48",
    });
  });

  it("reports an implicit :latest against an explicit pin", () => {
    // The upgrade half-done: one ref bumped to the release tag, the other left
    // on the locally-built default.
    expect(
      findRuntimeImageTagMismatch("appstrate-pi", "ghcr.io/appstrate/appstrate-sidecar:1.0.0")
        ?.piTag,
    ).toBe("latest");
  });

  it("stays silent when either ref is digest-pinned", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(
      findRuntimeImageTagMismatch(
        `ghcr.io/appstrate/appstrate-pi@${digest}`,
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0",
      ),
    ).toBeNull();
  });
});

describe("assertRuntimeImagePairPinned", () => {
  it("passes a matching pair", () => {
    expect(() => assertRuntimeImagePairPinned("appstrate-pi", "appstrate-sidecar")).not.toThrow();
  });

  it("throws naming both refs and both tags", () => {
    let message = "";
    try {
      assertRuntimeImagePairPinned(
        "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49",
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.48",
      );
    } catch (err) {
      message = (err as Error).message;
    }
    // The whole point of the gate is that the operator does not have to go
    // find which two values disagree.
    expect(message).toContain("PI_IMAGE=ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49");
    expect(message).toContain("SIDECAR_IMAGE=ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.48");
    expect(message).toContain("1.0.0-beta.49");
    expect(message).toContain("1.0.0-beta.48");
  });
});

describe("warnOnRuntimeImageRevisionDrift", () => {
  const labelsFor =
    (map: Record<string, string>) =>
    async (image: string): Promise<Record<string, string>> => {
      const revision = map[image];
      return revision ? { [OCI_REVISION_LABEL]: revision } : {};
    };

  it("reads the revision label of both images", async () => {
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: labelsFor({
        "appstrate-pi": "abc123def456",
        "appstrate-sidecar": "abc123def456",
      }),
    });
    expect(result).toEqual({ piRevision: "abc123def456", sidecarRevision: "abc123def456" });
  });

  it("surfaces the two revisions when the pair drifted", async () => {
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: labelsFor({
        "appstrate-pi": "aaaaaaaaaaaa",
        "appstrate-sidecar": "bbbbbbbbbbbb",
      }),
    });
    expect(result).toEqual({ piRevision: "aaaaaaaaaaaa", sidecarRevision: "bbbbbbbbbbbb" });
  });

  it("reports `unknown` for an unstamped image instead of failing", async () => {
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: labelsFor({ "appstrate-pi": "aaaaaaaaaaaa" }),
    });
    expect(result).toEqual({ piRevision: "aaaaaaaaaaaa", sidecarRevision: "unknown" });
  });

  it("never throws when the Docker inspect fails", async () => {
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: () => Promise.reject(new Error("docker daemon unreachable")),
    });
    expect(result).toEqual({ piRevision: "unknown", sidecarRevision: "unknown" });
  });
});
