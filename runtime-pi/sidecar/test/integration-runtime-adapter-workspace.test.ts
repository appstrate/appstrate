// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace propagation across runtime adapters.
 *
 * The process adapter sets `APPSTRATE_WORKSPACE` on the spawned
 * subprocess's env when both the spec opts in (`workspaceMount`) AND
 * the launching orchestrator supplies a directory handle. Mismatches
 * are surfaced as a warning, not a hard failure — the integration
 * still spawns, just without workspace access.
 *
 * The docker adapter test path is exercised end-to-end in
 * `apps/api/test/integration/services/docker-api.test.ts`
 * (volume + chown + bind mount). This module unit-tests the host
 * side that determines what env vars + mount flags the adapter
 * emits, which is the only piece the sidecar can hand-stub without
 * touching Docker.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProcessIntegrationRuntimeAdapter } from "../integration-runtime-adapter-process.ts";
import { WORKSPACE_ENV_VAR } from "../integration-runtime-adapter.ts";
import type { IntegrationSpawnSpec } from "../integrations-boot.ts";

function baseSpec(extra: Partial<IntegrationSpawnSpec> = {}): IntegrationSpawnSpec {
  return {
    integrationId: "@orga/test",
    namespace: "orga__test",
    sourceKind: "local",
    manifest: {
      name: "@orga/test",
      version: "0.1.0",
      server: { type: "bun", entry_point: "server.ts" },
    },
    spawnEnv: {},
    ...extra,
  };
}

describe("process adapter — workspace env propagation", () => {
  let bundleRoot: string;
  let workspacePath: string;

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "appstrate-bundle-"));
    workspacePath = await mkdtemp(join(tmpdir(), "appstrate-ws-test-"));
    // Bundle entry — a no-op script. The subprocess transport just
    // needs the file to exist so `node server.js` doesn't ENOENT.
    await mkdir(join(bundleRoot), { recursive: true });
    await writeFile(join(bundleRoot, "server.ts"), "process.exit(0);\n");
  });

  it("sets APPSTRATE_WORKSPACE when spec.workspaceMount + directory handle are both present", async () => {
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-1");

    // Capture the env the subprocess would see. We can't easily
    // introspect the spawned Bun subprocess from here, so we proxy
    // through a fake spawn by reading the subprocess's first action:
    // dump its env to a file. The spawned script writes the env to
    // disk and exits immediately.
    const envFile = join(bundleRoot, "env.dump");
    await writeFile(
      join(bundleRoot, "server.ts"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env)); process.exit(0);\n`,
    );

    const spawned = await adapter.spawn({
      runId: "run-1",
      spec: baseSpec({
        workspaceMount: { mount: "/workspace", access: "rw" },
      }),
      bundleRoot,
      egress: null,
      workspaceHandle: { kind: "directory", path: workspacePath },
      onStderrLine: () => {},
    });
    // SubprocessTransport defers spawn until `.start()` (which the
    // MCP Client normally calls during `connect`). The test bypasses
    // the MCP handshake — invoke `.start()` directly + wait for the
    // env-dump-and-exit script to flush.
    await spawned.transport.start();
    await new Promise((r) => setTimeout(r, 300));
    const dump = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(dump[WORKSPACE_ENV_VAR]).toBe(workspacePath);

    await spawned.transport.close().catch(() => {});
    await adapter.shutdown();
    await rm(bundleRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("omits APPSTRATE_WORKSPACE when spec opts in but orchestrator handle is null", async () => {
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-2");

    const envFile = join(bundleRoot, "env.dump");
    await writeFile(
      join(bundleRoot, "server.ts"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env)); process.exit(0);\n`,
    );

    const spawned = await adapter.spawn({
      runId: "run-2",
      spec: baseSpec({
        workspaceMount: { mount: "/workspace", access: "rw" },
      }),
      bundleRoot,
      egress: null,
      workspaceHandle: null, // Orchestrator carried no handle.
      onStderrLine: () => {},
    });
    await spawned.transport.start();
    await new Promise((r) => setTimeout(r, 300));
    const dump = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(dump[WORKSPACE_ENV_VAR]).toBeUndefined();

    await spawned.transport.close().catch(() => {});
    await adapter.shutdown();
    await rm(bundleRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("omits APPSTRATE_WORKSPACE when spec didn't opt in (no workspaceMount)", async () => {
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-3");

    const envFile = join(bundleRoot, "env.dump");
    await writeFile(
      join(bundleRoot, "server.ts"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env)); process.exit(0);\n`,
    );

    const spawned = await adapter.spawn({
      runId: "run-3",
      spec: baseSpec(), // no workspaceMount
      bundleRoot,
      egress: null,
      workspaceHandle: { kind: "directory", path: workspacePath },
      onStderrLine: () => {},
    });
    await spawned.transport.start();
    await new Promise((r) => setTimeout(r, 300));
    const dump = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(dump[WORKSPACE_ENV_VAR]).toBeUndefined();

    await spawned.transport.close().catch(() => {});
    await adapter.shutdown();
    await rm(bundleRoot, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
});
