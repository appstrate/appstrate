// SPDX-License-Identifier: Apache-2.0

/**
 * Image-reference parsing and the version-trio rule the env schema enforces at
 * boot: the platform, `PI_IMAGE` and `SIDECAR_IMAGE` must ship from the same
 * release, or the deployment boots fine and then fails runs with an opaque
 * upstream error naming none of the three (#1195 for the pi/sidecar pair,
 * #1177 for the platform ↔ runtime container boundary).
 *
 * This is the full case table for the rule — `packages/env/test/index.test.ts`
 * keeps only the two cases that prove the wiring, because a table maintained in
 * two places drifts in one of them.
 *
 * The rule has teeth (a bad trio aborts boot), so most of the surface here is
 * about what it must NOT reject: the zero-config dev box, a matching release
 * pin, a registry host carrying a port, a digest pin, and any platform with no
 * release identity of its own to compare against.
 */

import { describe, it, expect } from "bun:test";
import { parseImageRef, findRuntimeImageTagMismatch } from "../src/image-ref.ts";

const PI = "ghcr.io/appstrate/appstrate-pi";
const SIDECAR = "ghcr.io/appstrate/appstrate-sidecar";

describe("parseImageRef", () => {
  it("defaults a bare repository to :latest", () => {
    expect(parseImageRef("appstrate-pi")).toEqual({
      repository: "appstrate-pi",
      tag: "latest",
      digest: undefined,
    });
  });

  it("splits an explicit tag", () => {
    expect(parseImageRef(`${PI}:1.0.0-beta.49`)).toEqual({
      repository: PI,
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
    const ref = `${PI}@sha256:${"a".repeat(64)}`;
    expect(parseImageRef(ref)).toEqual({
      repository: PI,
      tag: undefined,
      digest: `sha256:${"a".repeat(64)}`,
    });
  });
});

describe("findRuntimeImageTagMismatch — the trio agrees", () => {
  it("accepts a release trio, stripping APP_VERSION's git-tag `v`", () => {
    // `APP_VERSION` is the git ref name (`v…`); the image tags come from
    // metadata-action's `{{version}}` (no `v`). Same release, one char apart.
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.51",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.51`,
      }),
    ).toBeNull();
  });

  it("accepts a platform version that already carries no `v`", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "1.0.0-beta.51",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.51`,
      }),
    ).toBeNull();
  });

  it("only strips a `v` that prefixes a version — `vnext` is a tag named vnext", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "vnext",
        piImage: `${PI}:vnext`,
        sidecarImage: `${SIDECAR}:vnext`,
      }),
    ).toBeNull();
  });
});

describe("findRuntimeImageTagMismatch — the platform is in the comparison", () => {
  it("reports runtime images one release behind the platform", () => {
    // The #1177 skew, and the whole reason the rule is over three values and
    // not two: this pair is internally consistent, so a pair-only rule passes
    // it and every `publish_file` then 404s at run time.
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.52",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.51`,
      }),
    ).toEqual({
      platformVersion: "1.0.0-beta.52",
      piTag: "1.0.0-beta.51",
      sidecarTag: "1.0.0-beta.51",
      // The platform is what stands alone; the fix is to move both images.
      oddOneOut: "platform",
    });
  });

  it("reports the platform one release behind its runtime images", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.51",
        piImage: `${PI}:1.0.0-beta.52`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.52`,
      })?.oddOneOut,
    ).toBe("platform");
  });

  it("reports one runtime image behind the other, naming the stale one", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.52",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.52`,
      }),
    ).toEqual({
      platformVersion: "1.0.0-beta.52",
      piTag: "1.0.0-beta.51",
      sidecarTag: "1.0.0-beta.52",
      oddOneOut: "pi",
    });
  });

  it("names no single outlier when all three differ", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.52",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.50`,
      })?.oddOneOut,
    ).toBeUndefined();
  });

  it("rejects floating :latest runtime images under a versioned platform", () => {
    // The hole this rule closes: the schema defaults are `…:latest`, so a
    // released image with a hand-edited `.env` floats its runtime images
    // forward while its own bytes stay pinned. An eager pull then lands a
    // newer runtime image on an older platform.
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.52",
        piImage: "appstrate-pi:latest",
        sidecarImage: "appstrate-sidecar:latest",
      })?.oddOneOut,
    ).toBe("platform");
  });
});

describe("findRuntimeImageTagMismatch — the platform drops out", () => {
  it("accepts the zero-config dev triple (no APP_VERSION, both implicitly :latest)", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: undefined,
        piImage: "appstrate-pi",
        sidecarImage: "appstrate-sidecar",
      }),
    ).toBeNull();
  });

  it("treats an explicit `dev` build identity as no identity", () => {
    // `ARG APP_VERSION=dev` is the Dockerfile default, so a locally built or
    // preview-built image reports the string rather than leaving it unset.
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "dev",
        piImage: "appstrate-pi:latest",
        sidecarImage: "appstrate-sidecar:latest",
      }),
    ).toBeNull();
  });

  it("treats an empty APP_VERSION as no identity", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "  ",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.51`,
      }),
    ).toBeNull();
  });

  it("still holds the pair to each other with no platform version", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: undefined,
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}:1.0.0-beta.50`,
      }),
    ).toEqual({
      platformVersion: undefined,
      piTag: "1.0.0-beta.51",
      sidecarTag: "1.0.0-beta.50",
      // Two comparable members: neither is the odd one out, they simply differ.
      oddOneOut: undefined,
    });
  });

  it("reports a half-done upgrade (one ref still on the local :latest default)", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: undefined,
        piImage: "appstrate-pi",
        sidecarImage: `${SIDECAR}:1.0.0`,
      })?.piTag,
    ).toBe("latest");
  });
});

describe("findRuntimeImageTagMismatch — digest pins", () => {
  const digest = `sha256:${"b".repeat(64)}`;

  it("stays silent when the pi ref is digest-pinned, platform version or not", () => {
    for (const platformVersion of [undefined, "v1.0.0-beta.52"]) {
      expect(
        findRuntimeImageTagMismatch({
          platformVersion,
          piImage: `${PI}@${digest}`,
          sidecarImage: `${SIDECAR}:1.0.0-beta.51`,
        }),
      ).toBeNull();
    }
  });

  it("stays silent when the sidecar ref is digest-pinned", () => {
    expect(
      findRuntimeImageTagMismatch({
        platformVersion: "v1.0.0-beta.52",
        piImage: `${PI}:1.0.0-beta.51`,
        sidecarImage: `${SIDECAR}@${digest}`,
      }),
    ).toBeNull();
  });
});
