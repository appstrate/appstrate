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
import { bootIntegrations } from "../integrations-boot.ts";
import { _setLogSinkForTesting } from "../logger.ts";

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
  try {
    return await bootIntegrations(
      [spec],
      { platformApiUrl: "http://platform.local", runToken: "run-token", fetchFn },
      undefined,
    );
  } finally {
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
