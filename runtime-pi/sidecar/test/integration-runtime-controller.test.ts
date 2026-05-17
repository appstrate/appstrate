// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the bootstrap controller — the runtime-pi entrypoint that
 * wires Phase 1.2a + 1.2b pure modules into a single startup pipeline.
 *
 * Hermetic — all I/O boundaries (fs, cert generator, Bun.spawn) are
 * injected. Real subprocess wiring is exercised by integration-spawner
 * tests; here we focus on composition correctness.
 */

import { describe, it, expect } from "bun:test";
import type { CaGenerationOutput, CaGenerationRequest, CertGenerator } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  bootstrapIntegrationRuntime,
  type FsWriter,
  type IntegrationToSpawn,
} from "../integration-runtime-controller.ts";
import type { BunSpawnFn, BunSubprocessLike } from "../integration-spawner.ts";

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const PEM_CERT = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const PEM_KEY = "-----BEGIN PRIVATE KEY-----\nMIIBfake\n-----END PRIVATE KEY-----\n";

function fakeCertGenerator(seen?: { reqs: CaGenerationRequest[] }): CertGenerator {
  return async (req) => {
    seen?.reqs.push(req);
    const out: CaGenerationOutput = {
      caCertPem: PEM_CERT,
      caKeyPem: PEM_KEY,
      serverCertPem: PEM_CERT,
      serverKeyPem: PEM_KEY,
    };
    return out;
  };
}

interface RecordingFs extends FsWriter {
  writes: Array<{ path: string; content: string; mode: string }>;
  mkdirs: Array<{ path: string; mode?: string }>;
}

function recordingFs(): RecordingFs {
  const writes: RecordingFs["writes"] = [];
  const mkdirs: RecordingFs["mkdirs"] = [];
  return {
    writes,
    mkdirs,
    async writeFile(path, content, mode) {
      writes.push({ path, content, mode });
    },
    async mkdir(path, mode) {
      mkdirs.push({ path, ...(mode ? { mode } : {}) });
    },
  };
}

function makeStubProc() {
  let exitedResolve!: (code: number) => void;
  const exited = new Promise<number>((res) => {
    exitedResolve = res;
  });
  const killSignals: Array<string | number | undefined> = [];
  let killed = false;
  const proc: BunSubprocessLike = {
    stdin: { write: () => 0, end: () => {} },
    stdout: new ReadableStream({ start: (c) => c.close() }),
    stderr: new ReadableStream({ start: (c) => c.close() }),
    exited,
    pid: Math.floor(Math.random() * 10000),
    get killed() {
      return killed;
    },
    kill(signal) {
      killSignals.push(signal);
      killed = true;
      // Test child exits cleanly on kill so supervisor stop() doesn't hang.
      exitedResolve(0);
    },
  };
  return { proc, killSignals, exitedResolve };
}

function recordingSpawn() {
  const calls: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  const stubs: ReturnType<typeof makeStubProc>[] = [];
  const fn: BunSpawnFn = (cmd, opts) => {
    const stub = makeStubProc();
    stubs.push(stub);
    calls.push({ cmd, env: opts.env });
    // Wire onExit so supervisor sees the exit.
    void stub.proc.exited.then((code) => opts.onExit?.(stub.proc, code, null, null));
    return stub.proc;
  };
  return { fn, calls, stubs };
}

function makeManifest(overrides: Partial<IntegrationManifest["server"]> = {}): IntegrationManifest {
  return {
    afpsVersion: "1.0.0",
    name: "@test/integration",
    version: "1.0.0",
    type: "integration",
    server: {
      type: "bun",
      entryPoint: "dist/server.js",
      ...overrides,
    } as IntegrationManifest["server"],
  } as IntegrationManifest;
}

function makeIntegration(id: string, opts: { afpsAware?: boolean } = {}): IntegrationToSpawn {
  return {
    integrationId: id,
    namespace: id,
    bundleRoot: `/bundles/${id}`,
    manifest: makeManifest(),
    ...(opts.afpsAware !== undefined ? { afpsAware: opts.afpsAware } : {}),
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe("bootstrapIntegrationRuntime — CA bundle materialisation", () => {
  it("plans the CA, mkdirs tmpfs, writes 3 files in order with planner-emitted modes", async () => {
    const fs = recordingFs();
    const seen = { reqs: [] as CaGenerationRequest[] };
    const spawn = recordingSpawn();

    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-1",
      integrations: [makeIntegration("a")],
      certGenerator: fakeCertGenerator(seen),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp/test-afps",
    });

    expect(fs.mkdirs).toEqual([{ path: "/tmp/test-afps", mode: "0700" }]);
    expect(fs.writes.length).toBe(3);
    expect(fs.writes[0]).toEqual({
      path: "/tmp/test-afps/ca.pem",
      content: PEM_CERT,
      mode: "0444",
    });
    expect(fs.writes[1]).toEqual({
      path: "/tmp/test-afps/server.crt",
      content: PEM_CERT,
      mode: "0400",
    });
    expect(fs.writes[2]).toEqual({
      path: "/tmp/test-afps/server.key",
      content: PEM_KEY,
      mode: "0400",
    });
    expect(seen.reqs.length).toBe(1);
    expect(seen.reqs[0]!.requiresAki).toBe(true);
    expect(seen.reqs[0]!.runId).toBe("run-1");

    await ctrl.shutdown();
  });
});

describe("bootstrapIntegrationRuntime — spawn composition", () => {
  it("invokes Bun.spawn for every integration with proxy 6-tuple + CA env", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();

    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-2",
      integrations: [makeIntegration("gmail"), makeIntegration("linear")],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      noProxy: ["sink.internal"],
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp/test-afps",
    });

    expect(spawn.calls.length).toBe(2);
    // D31 — node/bun always invoked via `bun <entry>`.
    expect(spawn.calls.every((c) => c.cmd[0] === "bun")).toBe(true);
    expect(spawn.calls[0]!.cmd[1]).toBe("/bundles/gmail/dist/server.js");
    expect(spawn.calls[1]!.cmd[1]).toBe("/bundles/linear/dist/server.js");

    // Proxy env (HTTPS_PROXY upper + http_proxy lower).
    expect(spawn.calls[0]!.env.HTTPS_PROXY).toBe("http://127.0.0.1:8443");
    expect(spawn.calls[0]!.env.https_proxy).toBe("http://127.0.0.1:8443");
    expect(spawn.calls[0]!.env.NO_PROXY).toBe("sink.internal");
    // CA env trio (Node + Python + libcurl).
    expect(spawn.calls[0]!.env.NODE_EXTRA_CA_CERTS).toBe("/tmp/test-afps/ca.pem");
    expect(spawn.calls[0]!.env.REQUESTS_CA_BUNDLE).toBe("/tmp/test-afps/ca.pem");
    expect(spawn.calls[0]!.env.SSL_CERT_FILE).toBe("/tmp/test-afps/ca.pem");
    expect(spawn.calls[0]!.env.CURL_CA_BUNDLE).toBe("/tmp/test-afps/ca.pem");

    expect(ctrl.running.length).toBe(2);
    expect(ctrl.running.map((r) => r.namespace).sort()).toEqual(["gmail", "linear"]);

    await ctrl.shutdown();
  });

  it("layers extraEnv on top of proxy env (extraEnv wins on collision)", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const integ: IntegrationToSpawn = {
      ...makeIntegration("gmail"),
      extraEnv: { HTTPS_PROXY: "override", MY_KEY: "secret-token" },
    };
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-3",
      integrations: [integ],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    expect(spawn.calls[0]!.env.HTTPS_PROXY).toBe("override");
    expect(spawn.calls[0]!.env.MY_KEY).toBe("secret-token");
    await ctrl.shutdown();
  });
});

describe("bootstrapIntegrationRuntime — server.type resolver", () => {
  it("python integration → spawn python <entry>", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const integ: IntegrationToSpawn = {
      integrationId: "py",
      namespace: "py",
      bundleRoot: "/bundles/py",
      manifest: makeManifest({ type: "python", entryPoint: "main.py" }),
    };
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-4",
      integrations: [integ],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    expect(spawn.calls[0]!.cmd[0]).toBe("python");
    expect(spawn.calls[0]!.cmd[1]).toBe("/bundles/py/main.py");
    await ctrl.shutdown();
  });

  it("docker integration → spawn docker run --rm -i --env … <ref>", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const integ: IntegrationToSpawn = {
      integrationId: "d",
      namespace: "d",
      bundleRoot: "/bundles/d",
      manifest: makeManifest({
        type: "docker",
        package: {
          registryType: "oci",
          identifier: "ghcr.io/example/mcp-server",
          digest: "sha256:" + "a".repeat(64),
        },
      } as IntegrationManifest["server"]),
    };
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-5",
      integrations: [integ],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    const cmd = spawn.calls[0]!.cmd;
    expect(cmd[0]).toBe("docker");
    expect(cmd[1]).toBe("run");
    expect(cmd[2]).toBe("--rm");
    expect(cmd[3]).toBe("-i");
    // Last arg = image ref.
    expect(cmd[cmd.length - 1]).toBe(`ghcr.io/example/mcp-server@sha256:${"a".repeat(64)}`);
    await ctrl.shutdown();
  });
});

describe("bootstrapIntegrationRuntime — SIGHUP credential refresh", () => {
  it("sends SIGHUP only to afpsAware integrations", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-6",
      integrations: [
        makeIntegration("aware", { afpsAware: true }),
        makeIntegration("not-aware", { afpsAware: false }),
      ],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    const result = await ctrl.refreshCredentials();
    expect(result.sent).toEqual(["aware"]);
    expect(result.skipped).toEqual(["not-aware"]);
    // The aware integration's stub must have received SIGHUP.
    const awareStub = spawn.stubs.find(
      (s, idx) => spawn.calls[idx]!.cmd[1] === "/bundles/aware/dist/server.js",
    );
    expect(awareStub!.killSignals).toContain("SIGHUP");
    await ctrl.shutdown();
  });
});

describe("bootstrapIntegrationRuntime — shutdown", () => {
  it("kills every child via the supervisor", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-7",
      integrations: [makeIntegration("a"), makeIntegration("b")],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    await ctrl.shutdown();
    expect(spawn.stubs.every((s) => s.killSignals.includes("SIGTERM"))).toBe(true);
  });

  it("shutdown is idempotent", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-8",
      integrations: [makeIntegration("a")],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    await ctrl.shutdown();
    await ctrl.shutdown();
    // No throw, both resolved.
    expect(true).toBe(true);
  });
});

describe("bootstrapIntegrationRuntime — exposes caBundle for the MITM listener", () => {
  it("returns the planner bundle on the controller", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-9",
      integrations: [makeIntegration("a")],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    expect(ctrl.caBundle.runId).toBe("run-9");
    expect(ctrl.caBundle.caCertPath).toBe("/tmp/ca.pem");
    expect(ctrl.caBundle.serverCertPath).toBe("/tmp/server.crt");
    expect(ctrl.caBundle.serverKeyPath).toBe("/tmp/server.key");
    expect(ctrl.caBundle.pems.caCertPem).toBe(PEM_CERT);
    await ctrl.shutdown();
  });
});

describe("bootstrapIntegrationRuntime — childFor()", () => {
  it("exposes the live SpawnedChildHandle per integration", async () => {
    const fs = recordingFs();
    const spawn = recordingSpawn();
    const ctrl = await bootstrapIntegrationRuntime({
      runId: "run-10",
      integrations: [makeIntegration("a")],
      certGenerator: fakeCertGenerator(),
      proxyUrl: "http://127.0.0.1:8443",
      fs,
      spawnOptions: { spawn: spawn.fn },
      tmpfsRoot: "/tmp",
    });
    const handle = ctrl.childFor("a");
    expect(handle).toBeDefined();
    expect(handle!.stdin).toBeDefined();
    expect(handle!.stdout).toBeDefined();
    expect(handle!.stderr).toBeDefined();
    expect(ctrl.childFor("nope")).toBeUndefined();
    await ctrl.shutdown();
  });
});
