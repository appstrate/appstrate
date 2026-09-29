// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapter — `delivery.files` when a run binds several connections of
 * one integration.
 *
 * Every runner of a run shares the host filesystem, and each connection's spec
 * declares the SAME path (`@appstrate/ssh` → `/run/secrets/ssh_key`). A path
 * another connection of the run already holds is refused: the runner would
 * read that connection's credential.
 *
 * The declared paths live in a temp dir so the test runs without root.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProcessIntegrationRuntimeAdapter } from "../integration-runtime-adapter-process.ts";
import type { IntegrationRuntimeAdapter } from "../integration-runtime-adapter.ts";
import type { IntegrationSpawnSpec } from "../integrations-boot.ts";
import { installPassthroughRunnerExec, type PassthroughRunnerExec } from "./helpers/runner-exec.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("process adapter — delivery.files across connections of one run", () => {
  let dir: string;
  let bundleRoot: string;
  let declaredPath: string;
  let wrapper: PassthroughRunnerExec;
  let adapter: IntegrationRuntimeAdapter;
  const runId = `run-collide-${process.pid}`;

  function spec(connectionId: string, path: string, content: string): IntegrationSpawnSpec {
    return {
      integrationId: "@appstrate/ssh",
      namespace: "ssh",
      connection: { id: connectionId, label: connectionId, accountId: null },
      sourceKind: "local",
      manifest: {
        name: "@appstrate/ssh",
        version: "1.0.0",
        server: { type: "bun", entry_point: "server.ts", packageId: "@appstrate/mcp-server-ssh" },
      },
      spawnEnv: {},
      fileMounts: { [path]: { content_b64: b64(content), mode: "0600" } },
    } as IntegrationSpawnSpec;
  }

  function spawn(s: IntegrationSpawnSpec) {
    return adapter.spawn({
      runId,
      spec: s,
      bundleRoot,
      egress: null,
      workspaceHandle: null,
      onStderrLine: () => {},
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appstrate-file-collision-"));
    bundleRoot = join(dir, "bundle");
    declaredPath = join(dir, "run", "secrets", "ssh_key");
    await Bun.write(join(bundleRoot, "server.ts"), "process.exit(0);");
    wrapper = await installPassthroughRunnerExec();
    adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare(runId);
  });

  afterEach(async () => {
    await adapter.shutdown();
    await wrapper.restore();
    await rm(dir, { recursive: true, force: true });
    await rm(join(tmpdir(), `appstrate-mounts-${runId}`), { recursive: true, force: true });
  });

  it("refuses a second connection on a path another connection holds, writing nothing", async () => {
    await spawn(spec("conn-web", declaredPath, "web-key"));

    const error = (await spawn(spec("conn-db", declaredPath, "db-key")).catch(
      (err: unknown) => err,
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("@appstrate/ssh");
    expect(error.message).toContain("[conn-db]");
    expect(error.message).toContain(declaredPath);
    expect(await readFile(declaredPath, "utf8")).toBe("web-key");
    expect(await Bun.file(join(tmpdir(), `appstrate-mounts-${runId}`)).exists()).toBe(false);
  });

  it("accepts the same connection again and connections on distinct paths", async () => {
    const otherPath = join(dir, "run", "secrets", "other_key");
    await spawn(spec("conn-web", declaredPath, "web-key"));
    await spawn(spec("conn-web", declaredPath, "web-key-2"));
    await spawn(spec("conn-db", otherPath, "db-key"));

    expect(await readFile(declaredPath, "utf8")).toBe("web-key-2");
    expect(await readFile(otherPath, "utf8")).toBe("db-key");
  });
});
