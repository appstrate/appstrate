// SPDX-License-Identifier: Apache-2.0

/**
 * Image-reference parsing and the pair-tag rule the env schema enforces at
 * boot: `PI_IMAGE` and `SIDECAR_IMAGE` must ship from the same release, or a
 * mismatched pair boots fine and then fails runs with an opaque upstream error
 * naming neither image (#1195, #1200).
 *
 * The rule has teeth (a bad pair aborts boot), so most of the surface here is
 * about what it must NOT reject: the zero-config dev pair, a matching release
 * pin, a registry host carrying a port, a digest pin.
 */

import { describe, it, expect } from "bun:test";
import { parseImageRef, findImageTagMismatch } from "../src/image-ref.ts";

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

describe("findImageTagMismatch", () => {
  it("accepts the zero-config dev pair (both implicitly :latest)", () => {
    expect(findImageTagMismatch("appstrate-pi", "appstrate-sidecar")).toBeNull();
  });

  it("accepts a release pair pinned to the same tag", () => {
    expect(
      findImageTagMismatch(
        "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49",
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.49",
      ),
    ).toBeNull();
  });

  it("reports a pair pinned one release apart", () => {
    expect(
      findImageTagMismatch(
        "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.49",
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.48",
      ),
    ).toEqual({ firstTag: "1.0.0-beta.49", secondTag: "1.0.0-beta.48" });
  });

  it("reports an implicit :latest against an explicit pin", () => {
    // The upgrade half-done: one ref bumped to the release tag, the other left
    // on the locally-built default.
    expect(
      findImageTagMismatch("appstrate-pi", "ghcr.io/appstrate/appstrate-sidecar:1.0.0")?.firstTag,
    ).toBe("latest");
  });

  it("stays silent when either ref is digest-pinned", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(
      findImageTagMismatch(
        `ghcr.io/appstrate/appstrate-pi@${digest}`,
        "ghcr.io/appstrate/appstrate-sidecar:1.0.0",
      ),
    ).toBeNull();
  });
});
