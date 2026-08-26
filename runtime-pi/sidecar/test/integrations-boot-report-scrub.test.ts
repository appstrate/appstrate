// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /integrations/boot-report` takes no auth — it is the agent container's
 * boot gate. Everything the boot loop puts on it (`failed[].error`, the error
 * breadcrumb's `message` and `data.error`) is therefore readable by the agent,
 * and much of it is text the sidecar did not write: a `connect.tool` login
 * tool's own error prose, a `docker`/runner diagnostic quoting back what it was
 * given, a platform error `detail`. Runner stderr also flows to the operator's
 * log aggregator on its way there.
 *
 * These tests pin the no-leak contract on both sinks. They do NOT assert that a
 * provider echoes credentials — the guarantee has to hold independently of
 * whether it does.
 *
 * Runs fully in-process — no Docker (the stderr case spawns one short-lived
 * `bun` subprocess through the process adapter).
 */

import { describe, it, expect } from "bun:test";
import { zipArtifact } from "@appstrate/core/zip";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations, scrubStderrLine } from "../integrations-boot.ts";
import { _setLogSinkForTesting } from "../logger.ts";
import { installPassthroughRunnerExec } from "./helpers/runner-exec.ts";

/** A shape `scrubSecretMaterial` masks, distinctive enough to grep for. */
const SECRET = "sk-ant-api03-LEAKED0000000000";
const SERVER_ID = "@tractr/leaky-server";

function localSpec(integrationId: string): IntegrationSpawnSpec {
  return {
    integrationId,
    namespace: "leaky",
    sourceKind: "local",
    manifest: {
      name: integrationId,
      version: "1.0.0",
      server: { type: "bun", entry_point: "./server.ts", packageId: SERVER_ID },
    },
    spawnEnv: {},
  } as IntegrationSpawnSpec;
}

async function boot(spec: IntegrationSpawnSpec, fetchFn: typeof fetch) {
  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
  // The process adapter refuses to spawn a local runner unless a
  // privilege-drop wrapper is configured (it would otherwise be a same-uid
  // child of the sidecar). The stderr case below needs a real subprocess, so
  // stand in the passthrough wrapper for the whole boot.
  const runnerExec = await installPassthroughRunnerExec();
  try {
    return await bootIntegrations(
      [spec],
      { platformApiUrl: "http://platform.local", runToken: "run-token", fetchFn },
      undefined,
    );
  } finally {
    await runnerExec.restore();
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

describe("boot report — third-party failure text is scrubbed", () => {
  it("masks credential material in failed[].error and on the error breadcrumb", async () => {
    // The bundle route is the shortest path to an error message the sidecar did
    // not author: `fetchBundleBytes` surfaces the upstream `detail` verbatim.
    // The sink under test is the per-spec catch, which is shared by every
    // failure source that reaches it (login-tool prose, runner diagnostics, …).
    const fetchFn = (async () =>
      new Response(JSON.stringify({ detail: `bundle refused: Bearer ${SECRET}` }), {
        status: 502,
      })) as unknown as typeof fetch;

    const result = await boot(localSpec("@tractr/leaky"), fetchFn);
    try {
      expect(result.report.ok).toBe(false);
      expect(result.failed).toHaveLength(1);

      const error = result.failed[0]!.error;
      // Still diagnosable...
      expect(error).toContain("bundle refused");
      // ...but the credential shapes are gone.
      expect(error).not.toContain(SECRET);
      expect(error).toContain("[redacted");

      const crumb = result.report.breadcrumbs.find((b) => b.level === "error")!;
      expect(crumb.message).not.toContain(SECRET);
      expect(String((crumb.data as { error?: unknown }).error)).not.toContain(SECRET);
    } finally {
      await result.shutdown();
    }
  });

  it("masks the MITM CA bring-up breadcrumb", async () => {
    // The CA breadcrumb interpolated `err.message` raw into the same
    // unauthenticated report. The message is not sidecar-authored on every
    // path: here `mkdtemp` quotes the TMPDIR it was handed straight back.
    const spec = {
      integrationId: "@tractr/mitm",
      namespace: "mitm",
      sourceKind: "none",
      manifest: { name: "@tractr/mitm", version: "1.0.0" },
      spawnEnv: {},
      httpDeliveryAuths: {
        main: {
          authKey: "main",
          authType: "custom",
          authorizedUris: ["https://api.example.com/**"],
        },
      },
    } as unknown as IntegrationSpawnSpec;

    const previousTmp = process.env.TMPDIR;
    const previousAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
    process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
    // Non-existent, so `prepareRunCa`'s own mkdtemp rejects with a message
    // that quotes the path.
    process.env.TMPDIR = `/nonexistent-Bearer-${SECRET}/`;
    let result: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
    try {
      result = await bootIntegrations(
        [spec],
        {
          platformApiUrl: "http://platform.local",
          runToken: "run-token",
          fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        },
        undefined,
      );
      const crumb = result.report.breadcrumbs.find((b) =>
        b.message.startsWith("MITM CA bring-up failed"),
      );
      expect(crumb).toBeDefined();
      // Still diagnosable — the failure mode survives.
      expect(crumb!.message).toContain("nonexistent");
      expect(crumb!.message).not.toContain(SECRET);
      expect(String((crumb!.data as { error?: unknown }).error)).not.toContain(SECRET);
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      if (previousAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
      else process.env.INTEGRATION_RUNTIME_ADAPTER = previousAdapter;
      if (result) await result.shutdown();
    }
  });

  it("masks runner stderr on the operator log, not only on the report copy", async () => {
    // Runner stderr already reached the report scrubbed; the operator's log
    // aggregator — a WIDER audience — was getting the raw line, because the
    // scrub sat on the report copy instead of at the callback entry.
    const bundle = zipArtifact({
      "server.ts": new TextEncoder().encode(
        `process.stderr.write("upstream auth failed: Bearer ${SECRET}\\n");\nprocess.exit(7);\n`,
      ),
    });
    const fetchFn = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/internal/mcp-server-bundle/")) {
        return new Response(bundle, { status: 200 });
      }
      return new Response(JSON.stringify({ detail: `unexpected: ${url}` }), { status: 404 });
    }) as unknown as typeof fetch;

    const lines: string[] = [];
    _setLogSinkForTesting((_level, line) => lines.push(line));
    // The suite preload pins LOG_LEVEL=error; the stderr relay is an `info`.
    // The logger reads the threshold per call precisely so a test can raise it
    // around one.
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    let result: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
    try {
      result = await boot(localSpec("@tractr/leaky-stderr"), fetchFn);
      const stderrLogs = lines.filter((l) => l.includes("integration stderr"));
      expect(stderrLogs.length).toBeGreaterThan(0);
      expect(stderrLogs.join("\n")).toContain("upstream auth failed");
      expect(stderrLogs.join("\n")).not.toContain(SECRET);
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
      _setLogSinkForTesting(null);
      if (result) await result.shutdown();
    }
  });
});

describe("scrubStderrLine", () => {
  // The 500-char cap is the tightest cut in the sidecar, so it is the one most
  // likely to land inside an authority — and the userinfo rule is the one rule
  // that needs a TERMINATOR (`@`) rather than matching from the credential's
  // start. Cut the `@` off and the rule cannot fire at all: the visible prefix
  // of the password went into `failed[].error` on the UNAUTHENTICATED
  // `GET /integrations/boot-report` the agent container reads.
  it("masks a connection string whose `@` falls past the 500-char cap", () => {
    const password = "S3cr3tP4ssw0rd".repeat(40); // 560 chars — `@` past the cap
    const out = scrubStderrLine(
      `Error: connect ECONNREFUSED postgres://svc_admin:${password}@db.internal:5432/app`,
    );
    expect(out).not.toContain("S3cr3tP4ssw0rd");
    expect(out).toContain("connect ECONNREFUSED postgres://");
  });

  // …and a line the cap did not cut keeps its host: the scrubber saw every
  // terminator there was, so there is nothing to be uncertain about.
  it("control: an uncut line keeps its host", () => {
    const line = "Error: connect ECONNREFUSED https://api.example.com:5432";
    expect(scrubStderrLine(line)).toBe(line);
  });
});
