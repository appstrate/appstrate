// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { formatDoctorReport, runDoctor, type ProbeBinary } from "../src/lib/doctor.ts";
import { type PathScanFs } from "../src/lib/path-scan.ts";
import { buildInternalInfoPayload, type InternalInfoPayload } from "../src/commands/internal.ts";

/**
 * Phase 3 — `appstrate doctor` (issue #249).
 *
 * The PATH walk is fully stubbed: tests pass a fake `pathScanFs` + a fake
 * `probeBinary` so no subprocess is ever spawned. Output rendering is
 * snapshot-style — we assert on substrings rather than exact strings to
 * stay resilient to incidental whitespace tweaks.
 */

function fs(map: Record<string, { exec: boolean; real?: string }>): PathScanFs {
  return {
    async isExecutable(p) {
      return map[p]?.exec ?? false;
    },
    async realpath(p) {
      return map[p]?.real ?? p;
    },
  };
}

function probe(
  responses: Record<
    string,
    { version?: string; source?: "curl" | "bun" | "unknown"; error?: string }
  >,
): ProbeBinary {
  return async (binary) => {
    const r = responses[binary];
    if (!r || r.error) {
      return { ok: false, error: r?.error ?? "no response" };
    }
    return {
      ok: true,
      version: r.version ?? "0.0.0",
      source: r.source ?? "unknown",
    };
  };
}

describe("runDoctor", () => {
  it("returns no installations when nothing on PATH", async () => {
    const report = await runDoctor({
      pathEnv: "/empty",
      pathScanFs: fs({}),
      probeBinary: probe({}),
      execPath: "/some/where",
    });
    expect(report.installations).toEqual([]);
    expect(report.runningIndex).toBe(-1);
    expect(report.dualInstall).toBe(false);
    expect(report.multiSource).toBe(false);
  });

  it("returns one installation and identifies the running binary", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({
        "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" },
      }),
      execPath: "/usr/local/bin/appstrate",
    });
    expect(report.installations).toHaveLength(1);
    expect(report.installations[0]!.source).toBe("curl");
    expect(report.installations[0]!.version).toBe("1.2.3");
    expect(report.runningIndex).toBe(0);
    expect(report.dualInstall).toBe(false);
    expect(report.multiSource).toBe(false);
  });

  it("flags dualInstall and multiSource when curl + bun coexist", async () => {
    const report = await runDoctor({
      pathEnv: "/a:/b",
      pathScanFs: fs({
        "/a/appstrate": { exec: true },
        "/b/appstrate": { exec: true },
      }),
      probeBinary: probe({
        "/a/appstrate": { version: "1.2.3", source: "curl" },
        "/b/appstrate": { version: "1.2.0", source: "bun" },
      }),
      execPath: "/a/appstrate",
    });
    expect(report.installations).toHaveLength(2);
    expect(report.dualInstall).toBe(true);
    expect(report.multiSource).toBe(true);
    expect(report.runningIndex).toBe(0);
  });

  it("reports probe failure with `version: null` and an error string", async () => {
    const report = await runDoctor({
      pathEnv: "/a",
      pathScanFs: fs({ "/a/appstrate": { exec: true } }),
      probeBinary: probe({ "/a/appstrate": { error: "timeout" } }),
      execPath: "/a/appstrate",
    });
    expect(report.installations[0]!.version).toBeNull();
    expect(report.installations[0]!.probeError).toBe("timeout");
    expect(report.installations[0]!.source).toBe("unknown");
  });

  it("matches the running binary by realpath when PATH entry is a symlink", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({
        "/usr/local/bin/appstrate": { exec: true, real: "/opt/appstrate/bin/appstrate" },
      }),
      probeBinary: probe({
        "/usr/local/bin/appstrate": { version: "1.0.0", source: "curl" },
      }),
      execPath: "/opt/appstrate/bin/appstrate",
    });
    expect(report.runningIndex).toBe(0);
  });

  it("matches the running binary when execPath itself is a symlink", async () => {
    // Reverse case: the PATH entry resolves directly, but execPath is a
    // wrapper symlink. Both sides must be realpath'd to find the match.
    const report = await runDoctor({
      pathEnv: "/opt/appstrate/bin",
      pathScanFs: fs({
        "/opt/appstrate/bin/appstrate": {
          exec: true,
          real: "/opt/appstrate/bin/appstrate",
        },
        // execPath used by the running CLI — a symlink alias.
        "/home/user/.local/bin/appstrate": {
          exec: true,
          real: "/opt/appstrate/bin/appstrate",
        },
      }),
      probeBinary: probe({
        "/opt/appstrate/bin/appstrate": { version: "1.0.0", source: "curl" },
      }),
      execPath: "/home/user/.local/bin/appstrate",
    });
    expect(report.runningIndex).toBe(0);
  });
});

describe("formatDoctorReport", () => {
  it("says 'No appstrate binary found' when empty", () => {
    const text = formatDoctorReport(
      {
        installations: [],
        runningIndex: -1,
        dualInstall: false,
        multiSource: false,
      },
      "/some/exec",
    );
    expect(text).toContain("No `appstrate` binary found on $PATH");
    expect(text).toContain("Running binary: /some/exec");
  });

  it("renders 1 install with star/arrow markers", () => {
    const text = formatDoctorReport(
      {
        installations: [
          {
            pathEntry: "/usr/local/bin",
            binary: "/usr/local/bin/appstrate",
            realPath: "/usr/local/bin/appstrate",
            version: "1.2.3",
            source: "curl",
          },
        ],
        runningIndex: 0,
        dualInstall: false,
        multiSource: false,
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).toContain("Found 1 installation");
    expect(text).toContain("/usr/local/bin/appstrate");
    expect(text).toContain("[curl]");
    expect(text).toContain("1.2.3");
    expect(text).toContain("★");
    expect(text).toContain("←");
  });

  it("renders 2 installs and includes the bun→remove hint when dual-source", () => {
    const text = formatDoctorReport(
      {
        installations: [
          {
            pathEntry: "/curl/bin",
            binary: "/curl/bin/appstrate",
            realPath: "/curl/bin/appstrate",
            version: "1.2.3",
            source: "curl",
          },
          {
            pathEntry: "/bun/bin",
            binary: "/bun/bin/appstrate",
            realPath: "/bun/bin/appstrate",
            version: "1.2.0",
            source: "bun",
          },
        ],
        runningIndex: 0,
        dualInstall: true,
        multiSource: true,
      },
      "/curl/bin/appstrate",
    );
    expect(text).toContain("Found 2 installations");
    expect(text).toContain("Multiple installations detected");
    expect(text).toContain("bun remove -g appstrate");
  });

  it("renders the same-channel cleanup hint when both installs report the same source", () => {
    const text = formatDoctorReport(
      {
        installations: [
          {
            pathEntry: "/a",
            binary: "/a/appstrate",
            realPath: "/a/appstrate",
            version: "1.2.3",
            source: "curl",
          },
          {
            pathEntry: "/b",
            binary: "/b/appstrate",
            realPath: "/b/appstrate",
            version: "1.2.3",
            source: "curl",
          },
        ],
        runningIndex: 0,
        dualInstall: true,
        multiSource: false,
      },
      "/a/appstrate",
    );
    expect(text).toContain("All installations report the same channel");
    expect(text).toContain("rm <path-from-doctor>");
  });
});

describe("connection-profile check", () => {
  const baseInstall = {
    pathEntry: "/usr/local/bin",
    binary: "/usr/local/bin/appstrate",
    realPath: "/usr/local/bin/appstrate",
    version: "1.2.3",
    source: "curl" as const,
  };

  it("attaches a missing result when the pinned profile id is not found", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      checkConnectionProfile: async () => ({
        profileId: "abc",
        status: "missing",
        hint: "Run `appstrate connections profile switch <name>`.",
      }),
    });
    expect(report.connectionProfile).toEqual({
      profileId: "abc",
      status: "missing",
      hint: "Run `appstrate connections profile switch <name>`.",
    });
  });

  it("omits the field when no profile is pinned (check returns null)", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      checkConnectionProfile: async () => null,
    });
    expect(report.connectionProfile).toBeUndefined();
  });

  it("fails soft (no `connectionProfile`) when the check throws", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      checkConnectionProfile: async () => {
        throw new Error("network down");
      },
    });
    expect(report.connectionProfile).toBeUndefined();
  });

  it("renders a warning line + hint in the report when status=missing", () => {
    const text = formatDoctorReport(
      {
        installations: [baseInstall],
        runningIndex: 0,
        dualInstall: false,
        multiSource: false,
        connectionProfile: {
          profileId: "abc",
          status: "missing",
          hint: "Run `appstrate connections profile switch <name>`.",
        },
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).toContain("Connection profile abc is pinned but no longer exists");
    expect(text).toContain("appstrate connections profile switch");
  });

  it("renders a neutral line when status=unknown (offline)", () => {
    const text = formatDoctorReport(
      {
        installations: [baseInstall],
        runningIndex: 0,
        dualInstall: false,
        multiSource: false,
        connectionProfile: { profileId: "abc", status: "unknown" },
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).toContain("could not be verified");
  });
});

describe("internal info payload", () => {
  it("returns a stable schema so older doctor versions can still parse it", () => {
    const payload = buildInternalInfoPayload();
    // Exhaustive shape check — the contract is "additive only".
    const expected: Array<keyof InternalInfoPayload> = ["version", "source", "schema"];
    for (const key of expected) {
      expect(payload).toHaveProperty(key);
    }
    expect(payload.schema).toBe(1);
    expect(["curl", "bun", "unknown"]).toContain(payload.source);
  });
});
