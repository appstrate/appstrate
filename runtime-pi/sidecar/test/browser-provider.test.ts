// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { assertBrowserWorkerCompatible, selectBrowserProvider } from "../browser-provider.ts";
import { createProcessBrowserProvider } from "../browser-provider-process.ts";
import { createDockerBrowserProvider } from "../browser-provider-docker.ts";

const spawnOptions = {
  runId: "run-1",
  integrationId: "@scope/browser",
  spec: {
    purpose: "automation" as const,
    protocol: "cdp-v1" as const,
    profile: "standard" as const,
    allowedOrigins: ["https://example.com"],
    sessionMode: "none" as const,
    trustedDriver: false,
  },
  egress: {
    proxyUrl: "http://sidecar:3000",
    authToken: "gateway-token-gateway-token-123456",
  },
  resources: {
    memoryBytes: 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 32,
    shmBytes: 512,
    maxContexts: 1,
    maxPages: 4,
  },
};

describe("browser provider registry", () => {
  it("selects only the explicitly requested backend", () => {
    expect(selectBrowserProvider({ BROWSER_PROVIDER: "process" }).id).toBe("process");
    expect(selectBrowserProvider({ BROWSER_PROVIDER: "process" }, "browser-use-cloud").id).toBe(
      "browser-use-cloud",
    );
    expect(() => selectBrowserProvider({ BROWSER_PROVIDER: "unknown" })).toThrow(/not registered/);
  });
});

describe("browser worker protocol", () => {
  it("rejects a worker protocol that cannot satisfy the declared capability", () => {
    expect(() =>
      assertBrowserWorkerCompatible("cdp-v1", {
        protocolVersion: 2,
        browserRevision: "Chromium/999",
      }),
    ).toThrow(/BROWSER_UNSUPPORTED_REVISION/);
    expect(() =>
      assertBrowserWorkerCompatible("cdp-v1", {
        protocolVersion: 1,
        browserRevision: "Chromium/149",
      }),
    ).not.toThrow();
  });
});

describe("process browser provider", () => {
  it("waits for the authenticated worker handshake and cleans it up idempotently", async () => {
    let killed = 0;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let capturedEnv: Record<string, string | undefined> = {};
    const provider = createProcessBrowserProvider({
      env: {
        APPSTRATE_BROWSER_EXEC: "/usr/local/bin/appstrate-browser-worker",
        APPSTRATE_BROWSER_EXECUTABLE: "/usr/bin/chromium",
      },
      spawn: (_command, options) => {
        capturedEnv = options.env;
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'APPSTRATE_BROWSER_WORKER_READY:{"endpoint":"http://127.0.0.1:49152","workerBuildId":"build-abc","protocolVersion":1,"browserRevision":"Chromium/1"}\n',
                ),
              );
              controller.close();
            },
          }),
          stderr: new ReadableStream(),
          exited,
          kill: () => {
            killed += 1;
            resolveExit(0);
          },
        };
      },
    });
    await provider.prepare("run-1");
    const handle = await provider.spawn(spawnOptions);
    expect(handle.endpoint).toBe("http://127.0.0.1:49152");
    expect(handle.workerBuildId).toBe("build-abc");
    expect(handle.authToken.length).toBeGreaterThanOrEqual(32);
    expect(capturedEnv.BROWSER_GATEWAY_TOKEN).toBe(spawnOptions.egress.authToken);
    expect(capturedEnv.APPSTRATE_BROWSER_EXECUTABLE).toBe("/usr/bin/chromium");
    await provider.stop(handle);
    await provider.stop(handle);
    expect(killed).toBe(1);
  });

  it("fails preflight when the first-party worker path is not configured", async () => {
    const provider = createProcessBrowserProvider({ env: {}, spawn: (() => {}) as never });
    await expect(provider.prepare("run-1")).rejects.toThrow(/BROWSER_WORKER_EXECUTABLE_PATH/);
  });

  it("rejects a worker that advertises a non-loopback control endpoint", async () => {
    let killed = 0;
    let resolveExit!: (code: number) => void;
    const provider = createProcessBrowserProvider({
      env: { BROWSER_WORKER_EXECUTABLE_PATH: "/opt/appstrate/browser-worker" },
      spawn: () => ({
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'APPSTRATE_BROWSER_WORKER_READY:{"endpoint":"http://attacker.example:8080","workerBuildId":"build-abc","protocolVersion":1,"browserRevision":"Chromium/1"}\n',
              ),
            );
            controller.close();
          },
        }),
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill: () => {
          killed += 1;
          resolveExit(0);
        },
      }),
    });
    await provider.prepare("run-1");
    await expect(provider.spawn(spawnOptions)).rejects.toThrow(/loopback HTTP origin/);
    expect(killed).toBe(1);
  });

  it("accepts the operator-facing worker executable setting", async () => {
    let command: string[] = [];
    const provider = createProcessBrowserProvider({
      env: { BROWSER_WORKER_EXECUTABLE_PATH: "/opt/appstrate/browser-worker" },
      spawn: (argv) => {
        command = argv;
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'APPSTRATE_BROWSER_WORKER_READY:{"endpoint":"http://127.0.0.1:49153","workerBuildId":"build-abc","protocolVersion":1,"browserRevision":"Chromium/1"}\n',
                ),
              );
              controller.close();
            },
          }),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
    });
    await provider.prepare("run-1");
    await provider.spawn(spawnOptions);
    expect(command).toEqual(["/opt/appstrate/browser-worker"]);
  });

  it("uses the fixed slot wrapper and control port in a Firecracker guest", async () => {
    let command: string[] = [];
    let workerEnv: Record<string, string | undefined> = {};
    const provider = createProcessBrowserProvider({
      env: {
        APPSTRATE_BROWSER_EXEC: "/usr/local/bin/appstrate-browser-exec",
        APPSTRATE_BROWSER_GUEST_ISOLATION: "1",
      },
      spawn: (argv, options) => {
        command = argv;
        workerEnv = options.env;
        return {
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'APPSTRATE_BROWSER_WORKER_READY:{"endpoint":"http://127.0.0.1:18085","workerBuildId":"build-abc","protocolVersion":1,"browserRevision":"Chromium/1"}\n',
                ),
              );
              controller.close();
            },
          }),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
    });
    await provider.prepare("run-1");
    await provider.spawn({
      ...spawnOptions,
      spec: { ...spawnOptions.spec, isolationSlot: 1 },
    });
    expect(command).toEqual(["/usr/local/bin/appstrate-browser-exec", "1"]);
    expect(workerEnv.PORT).toBe("18085");
    expect(workerEnv.BROWSER_WORKER_HOST).toBe("127.0.0.1");
    expect(workerEnv.BROWSER_GATEWAY_AUTH_PROXY_PORT).toBe("18086");
    expect(workerEnv.BROWSER_DEVTOOLS_PORT).toBe("18087");
  });
});

describe("docker browser provider", () => {
  it("keeps the bundled seccomp profile reachable by the non-root sidecar user", async () => {
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(
      "RUN install -d -o root -g root -m 0555 /usr/local/share/appstrate",
    );
  });

  it("keeps the vendored Chromium profile fail-closed and narrowly extended", async () => {
    const profile = JSON.parse(
      await readFile(new URL("../browser-seccomp.json", import.meta.url), "utf8"),
    ) as {
      defaultAction?: string;
      syscalls?: Array<{ names?: string[]; action?: string }>;
    };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const namespaceRule = profile.syscalls?.find(
      (rule) => rule.action === "SCMP_ACT_ALLOW" && rule.names?.includes("unshare"),
    );
    expect(namespaceRule?.names?.sort()).toEqual(
      ["chroot", "clone", "clone3", "setns", "unshare"].sort(),
    );
    expect(
      profile.syscalls?.some(
        (rule) => rule.action === "SCMP_ACT_ERRNO" && rule.names?.includes("clone3"),
      ),
    ).toBe(false);
  });

  it("fails preflight when the pinned seccomp profile is unavailable", async () => {
    const provider = createDockerBrowserProvider({
      env: { APPSTRATE_BROWSER_SECCOMP_PROFILE: "/missing/browser-seccomp.json" },
      existsFn: () => false,
    });
    await expect(provider.prepare("run-1")).rejects.toThrow(/seccomp profile is not installed/);
  });

  it("applies hardening/resource flags and keeps control tokens off argv", async () => {
    const calls: string[][] = [];
    let envFile = "";
    const provider = createDockerBrowserProvider({
      env: { RUN_ID: "run-1", BROWSER_WORKER_IMAGE: "worker@sha256:abc" },
      exec: async (args) => {
        calls.push(args);
        if (args[0] === "create") {
          const envIndex = args.indexOf("--env-file");
          envFile = await readFile(args[envIndex + 1]!, "utf8");
          return "container-id-123456789";
        }
        return "";
      },
      fetchFn: async () =>
        Response.json({
          workerBuildId: "build-abc",
          protocolVersion: 1,
          browserRevision: "Chromium/1",
        }),
    });
    await provider.prepare("run-1");
    const handle = await provider.spawn(spawnOptions);
    const create = calls.find((args) => args[0] === "create")!;
    expect(create).toContain("--read-only");
    expect(
      create.slice(create.indexOf("--memory-swap"), create.indexOf("--memory-swap") + 2),
    ).toEqual(["--memory-swap", String(spawnOptions.resources.memoryBytes)]);
    expect(create.slice(create.indexOf("--network"), create.indexOf("--network") + 2)).toEqual([
      "--network",
      "appstrate-exec-run-1",
    ]);
    expect(create).toContain("no-new-privileges");
    expect(create.some((value) => value.endsWith("browser-seccomp.json"))).toBe(true);
    expect(create).toContain("ALL");
    expect(create).toContain("worker@sha256:abc");
    expect(create.join(" ")).not.toContain(spawnOptions.egress.authToken);
    expect(create.join(" ")).not.toContain(handle.authToken);
    expect(envFile).toContain(`BROWSER_GATEWAY_TOKEN=${spawnOptions.egress.authToken}`);
    expect(envFile).toContain(`BROWSER_WORKER_TOKEN=${handle.authToken}`);
    expect(handle.workerBuildId).toBe("build-abc");
    await provider.shutdown();
    expect(calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
  });

  it("mounts an explicitly shared workspace read-only for Chromium uploads", async () => {
    const calls: string[][] = [];
    const provider = createDockerBrowserProvider({
      env: { RUN_ID: "run-1", BROWSER_WORKER_IMAGE: "worker:test" },
      exec: async (args) => {
        calls.push(args);
        return args[0] === "create" ? "container-id-workspace" : "";
      },
      fetchFn: async () =>
        Response.json({
          workerBuildId: "build-abc",
          protocolVersion: 1,
          browserRevision: "Chromium/1",
        }),
    });
    await provider.prepare("run-1");
    await provider.spawn({
      ...spawnOptions,
      workspace: {
        handle: { kind: "volume", name: "appstrate-workspace-run-1" },
        mount: "/workspace",
      },
    });
    const create = calls.find((args) => args[0] === "create")!;
    expect(create.slice(create.indexOf("--mount"), create.indexOf("--mount") + 2)).toEqual([
      "--mount",
      "type=volume,src=appstrate-workspace-run-1,dst=/workspace,readonly",
    ]);
  });

  it("removes a partially-created worker when container start fails", async () => {
    const calls: string[][] = [];
    const provider = createDockerBrowserProvider({
      env: { RUN_ID: "run-1", BROWSER_WORKER_IMAGE: "worker:test" },
      exec: async (args) => {
        calls.push(args);
        if (args[0] === "create") return "partial-container-id";
        if (args[0] === "start") throw new Error("injected start failure");
        return "";
      },
    });
    await provider.prepare("run-1");
    await expect(provider.spawn(spawnOptions)).rejects.toThrow(/injected start failure/);
    expect(calls).toContainEqual(["rm", "-f", "partial-container-id"]);
  });

  it("reclaims the claimed slot by name if docker returns an empty container id", async () => {
    const calls: string[][] = [];
    const provider = createDockerBrowserProvider({
      env: { RUN_ID: "run-1", BROWSER_WORKER_IMAGE: "worker:test" },
      exec: async (args) => {
        calls.push(args);
        return "";
      },
    });
    await provider.prepare("run-1");
    await expect(provider.spawn(spawnOptions)).rejects.toThrow(/returned no container id/);
    expect(calls).toContainEqual(["rm", "-f", "appstrate-browser-slot-0"]);
  });

  it("uses daemon-atomic global slots and fails closed when every slot is occupied", async () => {
    const attemptedNames: string[] = [];
    const provider = createDockerBrowserProvider({
      env: {
        RUN_ID: "run-1",
        BROWSER_WORKER_IMAGE: "worker:test",
        BROWSER_MAX_CONCURRENT: "2",
      },
      exec: async (args) => {
        if (args[0] !== "create") return "";
        attemptedNames.push(args[args.indexOf("--name") + 1]!);
        throw new Error("Conflict. The container name is already in use by another browser worker");
      },
    });
    await provider.prepare("run-1");
    await expect(provider.spawn(spawnOptions)).rejects.toThrow(/BROWSER_RESOURCE_LIMIT/);
    expect(attemptedNames).toEqual(["appstrate-browser-slot-0", "appstrate-browser-slot-1"]);
  });
});
