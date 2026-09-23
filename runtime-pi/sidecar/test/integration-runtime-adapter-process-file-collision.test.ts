// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapter — `delivery.files` when a run binds several connections of
 * one integration.
 *
 * Every runner of a run shares the host filesystem, and each connection's spec
 * declares the SAME path (`@appstrate/ssh` → `/run/secrets/ssh_key`). The first
 * connection keeps the declared path; a later one gets its own copy, and the
 * env var the manifest points its server at is repointed to it. A colliding
 * path no env var names is refused: the runner would read another
 * connection's credential.
 *
 * The declared paths live in a temp dir so the test runs without root.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProcessIntegrationRuntimeAdapter } from "../integration-runtime-adapter-process.ts";
import type {
  IntegrationRuntimeAdapter,
  SpawnedIntegration,
} from "../integration-runtime-adapter.ts";
import type { IntegrationSpawnSpec } from "../integrations-boot.ts";
import { installPassthroughRunnerExec, type PassthroughRunnerExec } from "./helpers/runner-exec.ts";

interface RunnerDump {
  keyPath: string;
  content: string;
  mountVars: Record<string, string>;
}

// The runner reports the path its env names, what it reads there, and any
// `APPSTRATE_FILE_MOUNT_*` override it was handed.
const RUNNER_SOURCE = `
import { readFileSync, writeFileSync } from "node:fs";
const keyPath = process.env.KEY_PATH;
const mountVars = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("APPSTRATE_FILE_MOUNT_")),
);
writeFileSync(process.env.DUMP, JSON.stringify({ keyPath, content: readFileSync(keyPath, "utf8"), mountVars }));
process.exit(0);
`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("process adapter — delivery.files across connections of one run", () => {
  let dir: string;
  let bundleRoot: string;
  let declaredPath: string;
  let wrapper: PassthroughRunnerExec;
  let adapter: IntegrationRuntimeAdapter;
  const runId = `run-collide-${process.pid}`;

  function spec(
    connection: { id: string; label: string },
    content: string,
    env: Record<string, string>,
    extraFiles: Record<string, string> = {},
  ): IntegrationSpawnSpec {
    return {
      integrationId: "@appstrate/ssh",
      namespace: "ssh",
      connection: { ...connection, accountId: null },
      sourceKind: "local",
      manifest: {
        name: "@appstrate/ssh",
        version: "1.0.0",
        server: { type: "bun", entry_point: "server.ts", packageId: "@appstrate/mcp-server-ssh" },
      },
      spawnEnv: { DUMP: join(dir, `${connection.id}.json`), ...env },
      fileMounts: {
        [declaredPath]: { content_b64: b64(content), mode: "0600" },
        ...Object.fromEntries(
          Object.entries(extraFiles).map(([path, body]) => [
            path,
            { content_b64: b64(body), mode: "0644" },
          ]),
        ),
      },
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

  // Starts the runner and returns what it read — its env as the adapter left
  // it, and the file at that path as it stands NOW.
  async function dump(spawned: SpawnedIntegration, s: IntegrationSpawnSpec): Promise<RunnerDump> {
    await spawned.transport.start();
    const path = s.spawnEnv.DUMP!;
    const deadline = Date.now() + 5_000;
    try {
      for (;;) {
        try {
          return JSON.parse(await readFile(path, "utf8")) as RunnerDump;
        } catch {
          if (Date.now() > deadline) throw new Error(`runner never wrote ${path}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } finally {
      await spawned.transport.close().catch(() => {});
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appstrate-file-collision-"));
    bundleRoot = join(dir, "bundle");
    declaredPath = join(dir, "run", "secrets", "ssh_key");
    await Bun.write(join(bundleRoot, "server.ts"), RUNNER_SOURCE);
    wrapper = await installPassthroughRunnerExec();
    adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare(runId);
  });

  afterEach(async () => {
    await chmod(join(dir, "run"), 0o700).catch(() => {});
    await adapter.shutdown();
    await wrapper.restore();
    await rm(dir, { recursive: true, force: true });
    await rm(join(tmpdir(), `appstrate-mounts-${runId}`), { recursive: true, force: true });
  });

  it("gives each connection its own file, reached through the env var the manifest declares", async () => {
    const webSpec = spec({ id: "conn-web", label: "web" }, "web-key", { KEY_PATH: declaredPath });
    const dbSpec = spec({ id: "conn-db", label: "db" }, "db-key", { KEY_PATH: declaredPath });
    // Both specs are materialised before either runner reads its key, as in
    // a run: an SSH server reads the key on each call, long after boot.
    const webRunner = await spawn(webSpec);
    const dbRunner = await spawn(dbSpec);
    const web = await dump(webRunner, webSpec);
    const db = await dump(dbRunner, dbSpec);

    expect(web.content).toBe("web-key");
    expect(db.content).toBe("db-key");
    // The first connection keeps the declared path.
    expect(web.keyPath).toBe(declaredPath);
    expect(web.mountVars).toEqual({});
    // The second is repointed to a per-connection copy, mode preserved.
    expect(db.keyPath).not.toBe(declaredPath);
    expect(db.keyPath).toContain(join(`appstrate-mounts-${runId}`, "conn-db"));
    expect(Object.values(db.mountVars)).toEqual([db.keyPath]);
    expect((await stat(db.keyPath)).mode & 0o777).toBe(0o600);

    await adapter.shutdown();
    expect(await Bun.file(db.keyPath).exists()).toBe(false);
    expect(await Bun.file(declaredPath).exists()).toBe(false);
  });

  it("leaves a single connection on the declared path with its env untouched", async () => {
    const onlySpec = spec({ id: "conn-only", label: "only" }, "only-key", {
      KEY_PATH: declaredPath,
    });
    const only = await dump(await spawn(onlySpec), onlySpec);

    expect(only.keyPath).toBe(declaredPath);
    expect(only.content).toBe("only-key");
    expect(only.mountVars).toEqual({});
  });

  it("refuses a second connection whose colliding path no env var names", async () => {
    await spawn(spec({ id: "conn-web", label: "web" }, "web-key", { KEY_PATH: declaredPath }));

    // The server would read the hardcoded declared path: web's key.
    const refused = spawn(spec({ id: "conn-db", label: "db" }, "db-key", {}));

    const error = (await refused.catch((err: unknown) => err)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("@appstrate/ssh");
    expect(error.message).toContain("[db]");
    expect(error.message).toContain(declaredPath);
    expect(await readFile(declaredPath, "utf8")).toBe("web-key");
  });

  // chmod 0o500 does not stop root from writing, so the fallback never fires there.
  it.skipIf(process.getuid?.() === 0)(
    "points the env var at the scratch copy when the declared path cannot be written",
    async () => {
      // A parent the sidecar may not write — `/run` for a non-root sidecar.
      await mkdir(join(dir, "run"), { recursive: true });
      await chmod(join(dir, "run"), 0o500);
      const onlySpec = spec({ id: "conn-only", label: "only" }, "only-key", {
        KEY_PATH: declaredPath,
      });
      const only = await dump(await spawn(onlySpec), onlySpec);

      expect(only.content).toBe("only-key");
      expect(only.keyPath).not.toBe(declaredPath);
      expect(Object.values(only.mountVars)).toEqual([only.keyPath]);
    },
  );

  it("repoints a second connection whose other declared file extends the colliding path", async () => {
    // `key.pub` starts with `key` but names another declared file, not an
    // embedding of `key`.
    const pubPath = `${declaredPath}.pub`;
    const make = (id: string, key: string) =>
      spec(
        { id, label: id },
        key,
        { KEY_PATH: declaredPath, PUB_PATH: pubPath },
        {
          [pubPath]: `${key}.pub`,
        },
      );
    const webSpec = make("conn-web", "web-key");
    const dbSpec = make("conn-db", "db-key");
    const webRunner = await spawn(webSpec);
    const db = await dump(await spawn(dbSpec), dbSpec);
    await dump(webRunner, webSpec);

    expect(db.content).toBe("db-key");
    expect(db.keyPath).not.toBe(declaredPath);
    expect(Object.values(db.mountVars)).toHaveLength(2);
    expect(Object.values(db.mountVars)).toContain(db.keyPath);
  });

  it("refuses a second connection whose env embeds the colliding path", async () => {
    await spawn(spec({ id: "conn-web", label: "web" }, "web-key", { KEY_PATH: declaredPath }));

    // `KEY_PATH` could be repointed; `SSH_OPTS` would still name web's file.
    const refused = spawn(
      spec({ id: "conn-db", label: "db" }, "db-key", {
        KEY_PATH: declaredPath,
        SSH_OPTS: `-i ${declaredPath}`,
      }),
    );

    const error = (await refused.catch((err: unknown) => err)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("[db]");
    expect(await readFile(declaredPath, "utf8")).toBe("web-key");
  });
});
