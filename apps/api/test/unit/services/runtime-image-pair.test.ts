// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-image build-stamp drift — the half of the `PI_IMAGE` /
 * `SIDECAR_IMAGE` version contract that only a Docker host can answer. The
 * same tag can still mean two different builds (`:latest` rebuilt on one side
 * only), so the platform compares `org.opencontainers.image.revision` on the
 * two images actually present after the pre-pull.
 *
 * Advisory by design, so these assert on what was compared rather than on log
 * output — and above all that no input makes it throw. The configuration rule
 * it complements lives in `packages/core/test/image-ref.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { OCI_REVISION_LABEL } from "@appstrate/core/image-ref";
import { warnOnRuntimeImageRevisionDrift } from "../../../src/services/orchestrator/runtime-image-pair.ts";

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
