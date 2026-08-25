// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-image build-stamp drift — the half of the `PI_IMAGE` /
 * `SIDECAR_IMAGE` version contract that only a Docker host can answer. The
 * same tag can still mean two different builds (`:latest` rebuilt on one side
 * only), so the platform compares `org.opencontainers.image.revision` on the
 * two images actually present after the pre-pull.
 *
 * The detection IS the warning: a drifted pair and a matched pair return the
 * same `{ piRevision, sidecarRevision }` shape, so asserting on the return
 * value alone cannot tell the two apart — deleting the comparison entirely
 * leaves every such assertion green. These therefore take the logger by
 * injection (same idiom as `local-queue-shutdown.test.ts`) and assert on the
 * emitted line, plus that no input makes the function throw. The configuration
 * rule it complements lives in `packages/core/test/image-ref.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { OCI_REVISION_LABEL } from "@appstrate/core/image-ref";
import type { Logger } from "@appstrate/core/logger";
import { warnOnRuntimeImageRevisionDrift } from "../../../src/services/orchestrator/runtime-image-pair.ts";

interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data?: Record<string, unknown>;
}

/** A `Logger` that records every call, for asserting on emitted lines. */
function recordingLogger(): { lines: LogLine[]; logger: Logger } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (msg: string, data?: Record<string, unknown>): void => {
      lines.push({ level, msg, data });
    };
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

/** The drift line specifically — not the "could not read the stamps" one. */
function driftLines(lines: LogLine[]): LogLine[] {
  return lines.filter((l) => l.msg.includes("different revisions"));
}

describe("warnOnRuntimeImageRevisionDrift", () => {
  const labelsFor =
    (map: Record<string, string>) =>
    async (image: string): Promise<Record<string, string>> => {
      const revision = map[image];
      return revision ? { [OCI_REVISION_LABEL]: revision } : {};
    };

  it("reads the revision label of both images, and says nothing about a matched pair", async () => {
    const { lines, logger } = recordingLogger();
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: labelsFor({
        "appstrate-pi": "abc123def456",
        "appstrate-sidecar": "abc123def456",
      }),
      logger,
    });
    expect(result).toEqual({ piRevision: "abc123def456", sidecarRevision: "abc123def456" });
    // The negative half of the drift case below: without it, a function that
    // warned unconditionally would satisfy that one.
    expect(lines).toEqual([]);
  });

  it("warns, naming both images and both revisions, when the pair drifted", async () => {
    const { lines, logger } = recordingLogger();
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: labelsFor({
        "appstrate-pi": "aaaaaaaaaaaa",
        "appstrate-sidecar": "bbbbbbbbbbbb",
      }),
      logger,
    });
    expect(result).toEqual({ piRevision: "aaaaaaaaaaaa", sidecarRevision: "bbbbbbbbbbbb" });

    // This is the whole product of the function, so it is asserted whole. The
    // operator reading it in a boot log has to be able to act on it without
    // knowing #1195 exists: which two images, which two builds, and the one
    // command that fixes it.
    const drift = driftLines(lines);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.level).toBe("warn");
    expect(drift[0]!.data?.piImage).toBe("appstrate-pi");
    expect(drift[0]!.data?.piRevision).toBe("aaaaaaaaaaaa");
    expect(drift[0]!.data?.sidecarImage).toBe("appstrate-sidecar");
    expect(drift[0]!.data?.sidecarRevision).toBe("bbbbbbbbbbbb");
    expect(drift[0]!.data?.hint).toContain("bun run docker:build:runtime");
  });

  it("reports `unknown` for an unstamped image, and stays silent about it", async () => {
    const { lines, logger } = recordingLogger();
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: labelsFor({ "appstrate-pi": "aaaaaaaaaaaa" }),
      logger,
    });
    expect(result).toEqual({ piRevision: "aaaaaaaaaaaa", sidecarRevision: "unknown" });
    // `unknown !== "aaaaaaaaaaaa"` is a string mismatch, not evidence of drift.
    // Without the short-circuit this would warn on every image built before
    // stamping — a warning nobody can act on.
    expect(driftLines(lines)).toEqual([]);
  });

  it("never throws when the Docker inspect fails, and says why", async () => {
    const { lines, logger } = recordingLogger();
    const result = await warnOnRuntimeImageRevisionDrift({
      piImage: "appstrate-pi",
      sidecarImage: "appstrate-sidecar",
      readImageLabels: () => Promise.reject(new Error("docker daemon unreachable")),
      logger,
    });
    expect(result).toEqual({ piRevision: "unknown", sidecarRevision: "unknown" });

    // Two unknowns are indistinguishable from an unstamped pair, so the reason
    // the comparison did not happen is only ever visible in this line.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toContain("Could not read runtime image build stamps");
    expect(lines[0]!.data?.error).toContain("docker daemon unreachable");
  });
});
