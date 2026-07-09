// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  defaultProbeFirecracker,
  formatDoctorReport,
  runDoctor,
  type FirecrackerHealth,
  type ProbeBinary,
} from "../src/lib/doctor.ts";
import { type PathScanFs } from "../src/lib/path-scan.ts";
import { buildInternalInfoPayload, type InternalInfoPayload } from "../src/commands/internal.ts";
import { CODE_DEFAULTS } from "../src/lib/compose-defaults.ts";

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
      probeLocalInstall: async () => null,
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
      probeLocalInstall: async () => null,
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
      probeLocalInstall: async () => null,
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
      probeLocalInstall: async () => null,
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
      probeLocalInstall: async () => null,
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
      probeLocalInstall: async () => null,
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

describe("local Docker-tier install probe (#343)", () => {
  // The doctor surfaces a hint block when a Tier 1/2/3 install is
  // detected on the host so users find the lifecycle commands without
  // having to read the issue.

  const baseInstall = {
    pathEntry: "/usr/local/bin",
    binary: "/usr/local/bin/appstrate",
    realPath: "/usr/local/bin/appstrate",
    version: "1.2.3",
    source: "curl" as const,
  };

  it("attaches a `localInstall` field when the probe finds a sidecar", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      probeLocalInstall: async (dir) => ({ dir, projectName: "appstrate-prod-cafebabe" }),
      installDir: "/srv/appstrate",
    });
    expect(report.localInstall).toEqual({
      dir: "/srv/appstrate",
      projectName: "appstrate-prod-cafebabe",
    });
  });

  it("omits `localInstall` when the probe returns null", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      probeLocalInstall: async () => null,
    });
    expect(report.localInstall).toBeUndefined();
  });

  it("fails soft (no `localInstall`) when the probe throws", async () => {
    const report = await runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      probeLocalInstall: async () => {
        throw new Error("disk error");
      },
    });
    expect(report.localInstall).toBeUndefined();
  });

  it("renders the lifecycle command hints when a local install is detected", () => {
    const text = formatDoctorReport(
      {
        installations: [baseInstall],
        runningIndex: 0,
        dualInstall: false,
        multiSource: false,
        localInstall: { dir: "/home/alice/appstrate", projectName: "appstrate-alice-deadbeef" },
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).toContain("Local Docker-tier install detected at /home/alice/appstrate");
    expect(text).toContain("appstrate-alice-deadbeef");
    expect(text).toContain("appstrate logs -f");
    expect(text).toContain("appstrate stop");
    expect(text).toContain("appstrate uninstall");
    expect(text).toContain("--purge");
  });

  it("does NOT render the lifecycle hint block when localInstall is absent", () => {
    const text = formatDoctorReport(
      {
        installations: [baseInstall],
        runningIndex: 0,
        dualInstall: false,
        multiSource: false,
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).not.toContain("Local Docker-tier install detected");
    expect(text).not.toContain("appstrate logs -f");
  });
});

describe("compose-drift check (#515)", () => {
  const onPath = {
    pathEnv: "/usr/local/bin",
    pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
    probeBinary: probe({
      "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" as const },
    }),
    execPath: "/usr/local/bin/appstrate",
  };
  const localInstall = async (dir: string) => ({ dir, projectName: "appstrate-prod-cafebabe" });
  const MODULES_DEFAULT = CODE_DEFAULTS.MODULES!;
  const STALE_COMPOSE = [
    "    environment:",
    `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`,
  ].join("\n");

  it("attaches composeDrift when a local install's compose has a stale default", async () => {
    const report = await runDoctor({
      ...onPath,
      probeLocalInstall: localInstall,
      installDir: "/srv/appstrate",
      readComposeFile: async () => STALE_COMPOSE,
    });
    expect(report.composeDrift).toBeDefined();
    expect(report.composeDrift).toHaveLength(1);
    expect(report.composeDrift![0]).toMatchObject({ kind: "duplicate", varName: "MODULES" });
  });

  it("omits composeDrift when the compose file is clean", async () => {
    const report = await runDoctor({
      ...onPath,
      probeLocalInstall: localInstall,
      installDir: "/srv/appstrate",
      readComposeFile: async () => "    environment:\n      - MODULES",
    });
    expect(report.composeDrift).toBeUndefined();
  });

  it("does NOT read the compose file when there is no local install", async () => {
    let read = false;
    const report = await runDoctor({
      ...onPath,
      probeLocalInstall: async () => null,
      readComposeFile: async () => {
        read = true;
        return STALE_COMPOSE;
      },
    });
    expect(read).toBe(false);
    expect(report.composeDrift).toBeUndefined();
  });

  it("omits composeDrift when the compose file is absent (reader returns null)", async () => {
    const report = await runDoctor({
      ...onPath,
      probeLocalInstall: localInstall,
      installDir: "/srv/appstrate",
      readComposeFile: async () => null,
    });
    expect(report.composeDrift).toBeUndefined();
  });

  it("fails soft (no composeDrift) when the reader throws", async () => {
    const report = await runDoctor({
      ...onPath,
      probeLocalInstall: localInstall,
      installDir: "/srv/appstrate",
      readComposeFile: async () => {
        throw new Error("permission denied");
      },
    });
    // The local install is still reported — only the drift section is skipped.
    expect(report.localInstall).toBeDefined();
    expect(report.composeDrift).toBeUndefined();
  });

  it("renders the drift section with the --upgrade-compose hint", () => {
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
        localInstall: { dir: "/srv/appstrate", projectName: "appstrate-prod-cafebabe" },
        composeDrift: [
          {
            kind: "duplicate",
            line: 2,
            varName: "MODULES",
            yamlDefault: "a,b",
            codeDefault: "a,b",
            raw: "      - MODULES=${MODULES:-a,b}",
          },
        ],
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).toContain("Compose drift");
    expect(text).toContain("MODULES");
    expect(text).toContain("appstrate install --upgrade-compose");
  });

  it("renders allowlist-drift findings as manual-review, not auto-fixable", () => {
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
        localInstall: { dir: "/srv/appstrate", projectName: "appstrate-prod-cafebabe" },
        composeDrift: [
          {
            kind: "allowlist-drift",
            line: 9,
            varName: "RUN_ADAPTER",
            yamlDefault: "process",
            expectedYamlDefault: "docker",
            raw: "      - RUN_ADAPTER=${RUN_ADAPTER:-process}",
          },
        ],
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).toContain("Intentional overrides");
    expect(text).toContain("RUN_ADAPTER");
    expect(text).toContain("review by hand");
  });

  it("does NOT render a drift section when composeDrift is absent", () => {
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
        localInstall: { dir: "/srv/appstrate", projectName: "appstrate-prod-cafebabe" },
      },
      "/usr/local/bin/appstrate",
    );
    expect(text).not.toContain("Compose drift");
  });
});

describe("runDoctor — Firecracker runner reachability (#819)", () => {
  const localInstall = { dir: "/srv/appstrate", projectName: "appstrate-prod-cafebabe" };
  const firecrackerEnv =
    "RUN_ADAPTER=firecracker\nFIRECRACKER_RUNNER_URL=http://10.0.0.9:3100\nFIRECRACKER_RUNNER_TOKEN=tok-abcdef1234567890\n";

  async function run(
    readEnv: string | null,
    probeFirecracker?: (url: string, token: string) => Promise<FirecrackerHealth>,
  ) {
    return runDoctor({
      pathEnv: "/usr/local/bin",
      pathScanFs: fs({ "/usr/local/bin/appstrate": { exec: true } }),
      probeBinary: probe({ "/usr/local/bin/appstrate": { version: "1.2.3", source: "curl" } }),
      execPath: "/usr/local/bin/appstrate",
      probeLocalInstall: async () => localInstall,
      readComposeFile: async () => null,
      readEnvFile: async () => readEnv,
      probeFirecracker,
    });
  }

  it("reports ok when the daemon health probe returns 200", async () => {
    let probedUrl = "";
    let probedToken = "";
    const report = await run(firecrackerEnv, async (url, token) => {
      probedUrl = url;
      probedToken = token;
      return { status: "ok", url };
    });
    expect(report.firecracker).toEqual({ status: "ok", url: "http://10.0.0.9:3100" });
    expect(probedUrl).toBe("http://10.0.0.9:3100");
    expect(probedToken).toBe("tok-abcdef1234567890");
    expect(formatDoctorReport(report, "/usr/local/bin/appstrate")).toContain(
      "reachable and authorized",
    );
  });

  it("reports unauthorized (401) with a runner-doctor hint", async () => {
    const report = await run(firecrackerEnv, async (url) => ({
      status: "unauthorized",
      url,
      detail: "HTTP 401",
    }));
    expect(report.firecracker?.status).toBe("unauthorized");
    const text = formatDoctorReport(report, "/usr/local/bin/appstrate");
    expect(text).toContain("unauthorized");
    expect(text).toContain("appstrate runner doctor");
  });

  it("reports unreachable on a connection error / timeout", async () => {
    const report = await run(firecrackerEnv, async (url) => ({
      status: "unreachable",
      url,
      detail: "The operation was aborted",
    }));
    expect(report.firecracker?.status).toBe("unreachable");
    expect(formatDoctorReport(report, "/usr/local/bin/appstrate")).toContain("unreachable");
  });

  it("skips the probe entirely for a docker-backend install", async () => {
    let probed = false;
    const report = await run("RUN_ADAPTER=docker\n", async (url) => {
      probed = true;
      return { status: "ok", url };
    });
    expect(report.firecracker).toBeUndefined();
    expect(probed).toBe(false);
  });

  it("skips the probe when there is no .env", async () => {
    let probed = false;
    const report = await run(null, async (url) => {
      probed = true;
      return { status: "ok", url };
    });
    expect(report.firecracker).toBeUndefined();
    expect(probed).toBe(false);
  });
});

describe("defaultProbeFirecracker — unix:// runner URL (UDS transport, #868)", () => {
  /** Fake fetch capturing the target + init so we can assert the unix option. */
  function capturingFetch(status: number) {
    const calls: Array<{ input: string; init?: RequestInit & { unix?: string } }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit & { unix?: string }) => {
      calls.push({ input: String(input), init });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("dials the socket via the fetch `unix` option (path from the three-slash URL)", async () => {
    const { calls, fetchImpl } = capturingFetch(200);
    const health = await defaultProbeFirecracker(
      "unix:///run/appstrate-runner/runner.sock",
      "tok-abcdef1234567890",
      fetchImpl,
    );
    expect(health).toEqual({ status: "ok", url: "unix:///run/appstrate-runner/runner.sock" });
    expect(calls).toHaveLength(1);
    // The authority is a placeholder; the socket path is what gets dialed.
    expect(calls[0]!.input).toBe("http://appstrate-runner/v1/health");
    expect(calls[0]!.init?.unix).toBe("/run/appstrate-runner/runner.sock");
    // Same bearer-token behavior as the TCP probe.
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer tok-abcdef1234567890",
    );
  });

  it("keeps the TCP path untouched: no unix option, URL dialed directly", async () => {
    const { calls, fetchImpl } = capturingFetch(200);
    const health = await defaultProbeFirecracker(
      "http://10.0.0.9:3100",
      "tok-abcdef1234567890",
      fetchImpl,
    );
    expect(health.status).toBe("ok");
    expect(calls[0]!.input).toBe("http://10.0.0.9:3100/v1/health");
    expect(calls[0]!.init?.unix).toBeUndefined();
  });

  it("classifies a 401 over the socket as unauthorized (status logic unchanged)", async () => {
    const { fetchImpl } = capturingFetch(401);
    const health = await defaultProbeFirecracker(
      "unix:///run/appstrate-runner/runner.sock",
      "wrong-token-1234567890",
      fetchImpl,
    );
    expect(health.status).toBe("unauthorized");
    expect(health.detail).toBe("HTTP 401");
  });

  it("refuses the two-slash unix typo instead of probing the wrong socket", async () => {
    // unix://var/run/x.sock parses "var" as a hostname — probing
    // /run/x.sock would contradict the platform's boot refusal of the
    // same URL. No fetch must happen.
    const { calls, fetchImpl } = capturingFetch(200);
    const health = await defaultProbeFirecracker(
      "unix://var/run/x.sock",
      "tok-abcdef1234567890",
      fetchImpl,
    );
    expect(health.status).toBe("unreachable");
    expect(health.detail).toContain("THREE slashes");
    expect(calls).toHaveLength(0);
  });

  it("keeps a unix:// URL verbatim — no trailing-slash strip on a socket path", async () => {
    const { calls, fetchImpl } = capturingFetch(200);
    await defaultProbeFirecracker(
      // A trailing slash on a unix path names a DIFFERENT node — the
      // http(s)-only normalization must not touch it.
      "unix:///run/appstrate-runner/runner.sock/",
      "tok-abcdef1234567890",
      fetchImpl,
    );
    expect(calls[0]!.init?.unix).toBe("/run/appstrate-runner/runner.sock/");
  });

  it("appends a sudo hint when the socket probe fails with EACCES (rootless doctor)", async () => {
    const fetchImpl = (async () => {
      throw new Error("EACCES: permission denied, connect");
    }) as unknown as typeof fetch;
    const health = await defaultProbeFirecracker(
      "unix:///run/appstrate-runner/runner.sock",
      "tok-abcdef1234567890",
      fetchImpl,
    );
    expect(health.status).toBe("unreachable");
    expect(health.detail).toContain("re-run with sudo");
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
