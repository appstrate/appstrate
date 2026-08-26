// SPDX-License-Identifier: Apache-2.0

/**
 * Docker adapter — credential delivery into the runner container.
 *
 * Two things the runner receives at `docker create` time carry live credential
 * material: the 0600 `--env-file` (`delivery.env`) and the `delivery.files`
 * mounts (AFPS §7.6, CC-5). Both are exercised here through the REAL
 * `adapter.spawn()`, with `Bun.spawn` stubbed so no docker daemon is involved:
 * `dockerExec` resolves the CLI through `globalThis.Bun.spawn` and
 * `SubprocessTransport` only spawns on `start()`, which spawn() never calls.
 *
 * Runs fully in-process — no Docker.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import {
  stageFileMountsOnHost,
  writeSecretEnvFile,
} from "../integration-runtime-adapter-docker.ts";
import { selectIntegrationRuntimeAdapter } from "../integration-runtime-adapter.ts";

const FAKE_CONTAINER_ID = "c0ffee1234567890";

interface DockerCall {
  args: string[];
  env: Record<string, string>;
  /** Contents of the `--env-file` at the moment docker was invoked, if any. */
  envFileBody?: string;
}

/**
 * Replace `Bun.spawn` with a fake `docker` for the duration of `body`.
 * Restored in a `finally` — `bun test` runs every file in one process, so a
 * leaked stub would poison unrelated suites.
 */
async function withFakeDocker<T>(body: (calls: DockerCall[]) => Promise<T>): Promise<T> {
  const calls: DockerCall[] = [];
  const globalBun = globalThis as unknown as { Bun: { spawn: unknown } };
  const original = globalBun.Bun.spawn;
  globalBun.Bun.spawn = (cmd: string[], opts: { env: Record<string, string> }) => {
    const args = cmd.slice(1);
    const call: DockerCall = { args, env: opts.env };
    // `docker create` reads the env-file synchronously and the adapter deletes
    // it the moment create returns — capture it here or never.
    const envFileIdx = args.indexOf("--env-file");
    if (envFileIdx !== -1 && args[envFileIdx + 1]) {
      call.envFileBody = readFileSync(args[envFileIdx + 1]!, "utf8");
    }
    calls.push(call);
    const stdout = args[0] === "create" ? FAKE_CONTAINER_ID : "";
    return {
      stdout: new Response(stdout).body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };
  try {
    return await body(calls);
  } finally {
    globalBun.Bun.spawn = original;
  }
}

function spec(overrides: Partial<IntegrationSpawnSpec> = {}): IntegrationSpawnSpec {
  return {
    integrationId: "@tractr/gmail",
    namespace: "gmail",
    sourceKind: "local",
    manifest: {
      name: "@tractr/gmail",
      version: "1.0.0",
      server: { type: "node", entry_point: "./server.js", packageId: "@tractr/gmail-server" },
    },
    spawnEnv: {},
    ...overrides,
  } as IntegrationSpawnSpec;
}

function dockerAdapter() {
  return selectIntegrationRuntimeAdapter({
    INTEGRATION_RUNTIME_ADAPTER: "docker",
  } as NodeJS.ProcessEnv);
}

async function spawnWith(
  calls: DockerCall[],
  s: IntegrationSpawnSpec,
): Promise<ReturnType<typeof dockerAdapter>> {
  const adapter = dockerAdapter();
  await adapter.spawn({
    runId: "run-123456789",
    spec: s,
    bundleRoot: "/tmp/bundle-does-not-need-to-exist",
    egress: null,
    workspaceHandle: null,
    onStderrLine: () => {},
  });
  expect(calls.some((c) => c.args[0] === "create")).toBe(true);
  return adapter;
}

describe("writeSecretEnvFile — docker --env-file line containment", () => {
  it("writes one KEY=VALUE line per entry", async () => {
    const { path } = await writeSecretEnvFile({ A: "1", B: "two" });
    expect(await readFile(path, "utf8")).toBe("A=1\nB=two");
    // 0600 so only the sidecar uid can read the decrypted values.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses a value containing a newline", async () => {
    // A GCP service-account `private_key`, an SSH key, or a token pasted with
    // a trailing newline all reach `delivery.env` this way. Docker resolves a
    // line with no `=` against its OWN environment, so the injected line below
    // would have copied the sidecar's RUN_TOKEN into the runner.
    await expect(
      writeSecretEnvFile({ GCP_KEY: "-----BEGIN PRIVATE KEY-----\nRUN_TOKEN" }),
    ).rejects.toThrow(/GCP_KEY/);
  });

  it("refuses an EMBEDDED carriage return", async () => {
    // Docker's scanner (`bufio.ScanLines`) strips a trailing `\r` but leaves a
    // lone interior one attached to the value; other readers treat it as a
    // line break. The embedded case stays closed.
    await expect(writeSecretEnvFile({ K: "a\rb" })).rejects.toThrow(/"K"/);
    await expect(writeSecretEnvFile({ K: "a\r\nRUN_TOKEN" })).rejects.toThrow(/"K"/);
  });

  it("accepts a value that merely ENDS with a newline", async () => {
    // The motivating case in this function's own docstring: a token pasted
    // with a trailing newline. Entries are joined with `\n`, so a trailing
    // newline produces an EMPTY line, which docker's parser skips (`len(line)
    // > 0` guard) — no bare-name line, no environ resolution. Refusing it
    // turned a working integration into `ok:false` and aborted the run, and
    // diverged by tier (process/Firecracker pass env directly and kept
    // working).
    const { path } = await writeSecretEnvFile({ TOKEN: "tok-123\n", B: "x\r\n" });
    expect(await readFile(path, "utf8")).toBe("TOKEN=tok-123\nB=x");
  });

  it("refuses a key that is not a portable env-var name", async () => {
    // An empty key emits `=<value>` and docker answers `no variable name on
    // line '=<value>'` — echoing the DECRYPTED credential into `failed[].error`
    // on the unauthenticated boot report. A key containing `=` silently sets a
    // different variable (docker splits on the first `=`).
    await expect(writeSecretEnvFile({ "": "s3cr3t-value" })).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("s3cr3t-value") as unknown as string,
      }),
    );
    await expect(writeSecretEnvFile({ "A=B": "v" })).rejects.toThrow(/"A=B"/);
    await expect(writeSecretEnvFile({ "#K": "v" })).rejects.toThrow(/"#K"/);
    await expect(writeSecretEnvFile({ "K\nINJECTED": "v" })).rejects.toThrow(/INJECTED/);
    await expect(writeSecretEnvFile({ "1BAD": "v" })).rejects.toThrow(/"1BAD"/);
    await expect(writeSecretEnvFile({ "HAS SPACE": "v" })).rejects.toThrow(/"HAS SPACE"/);
  });

  it("accepts a value starting with '#' or '='", async () => {
    // Neither is a docker parse hazard: a `#` comment is only recognised at
    // LINE start and the value never is, and `SplitN(line, "=", 2)` gives the
    // whole remainder to the value. Refusing them broke passwords.
    const { path } = await writeSecretEnvFile({ P: "#hash-first", Q: "=equals-first" });
    expect(await readFile(path, "utf8")).toBe("P=#hash-first\nQ==equals-first");
  });

  it("never names the value in the rejection", async () => {
    const secret = "ya29.SUPER-SECRET-VALUE";
    await expect(writeSecretEnvFile({ TOKEN: `${secret}\nRUN_TOKEN` })).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("SUPER-SECRET-VALUE") as unknown as string,
      }),
    );
  });
});

describe("docker adapter spawn — credential env delivery", () => {
  it("rejects the spawn before creating a container when a value would break its line", async () => {
    await withFakeDocker(async (calls) => {
      await expect(
        dockerAdapter().spawn({
          runId: "run-123456789",
          spec: spec({ spawnEnv: { GCP_KEY: "line1\nPROXY_URL" } }),
          bundleRoot: "/tmp/bundle-does-not-need-to-exist",
          egress: null,
          workspaceHandle: null,
          onStderrLine: () => {},
        }),
      ).rejects.toThrow(/GCP_KEY/);
      expect(calls).toEqual([]);
    });
  });

  it("passes the docker CLI an explicit minimal env, never the sidecar's own", async () => {
    // Defence in depth for the same defect: docker resolves an `=`-less
    // env-file line from the CLI process's environment, and `Bun.spawn`
    // defaults that to `process.env` — the sidecar's whole environ.
    const previous = process.env.RUN_TOKEN;
    process.env.RUN_TOKEN = "rt-must-not-leak";
    try {
      await withFakeDocker(async (calls) => {
        await spawnWith(calls, spec({ spawnEnv: { OK: "value" } }));
        for (const call of calls) {
          expect(
            Object.keys(call.env).every((k) => ["PATH", "HOME", "DOCKER_HOST"].includes(k)),
          ).toBe(true);
          expect(call.env.RUN_TOKEN).toBeUndefined();
        }
      });
    } finally {
      if (previous === undefined) delete process.env.RUN_TOKEN;
      else process.env.RUN_TOKEN = previous;
    }
  });

  it("still delivers a well-formed env-file off the command line", async () => {
    await withFakeDocker(async (calls) => {
      await spawnWith(calls, spec({ spawnEnv: { API_TOKEN: "tok-123" } }));
      const create = calls.find((c) => c.args[0] === "create")!;
      expect(create.envFileBody).toBe("API_TOKEN=tok-123");
      // Secrets must never ride argv (`/proc/<pid>/cmdline` is world-readable).
      expect(create.args.join(" ")).not.toContain("tok-123");
    });
  });
});

describe("stageFileMountsOnHost — delivery.files (AFPS §7.6, CC-5)", () => {
  it("stages two entries as two distinct host files", async () => {
    // The regression: the host filename was `f-${hostTempFiles.length}` off a
    // counter pushed to once BEFORE the loop, so every entry wrote to `f-1`.
    // Iteration 1 chmod'ed it 0400 and iteration 2's writeFile died with
    // EACCES (the sidecar is `nobody:nobody`, no CAP_DAC_OVERRIDE), so no
    // integration with two `delivery.files` entries could boot.
    const dir = await stageFileMountsOnHost({
      "/run/creds/client.pem": {
        content_b64: Buffer.from("CERT").toString("base64"),
        mode: "0400",
      },
      "/run/creds/client.key": { content_b64: Buffer.from("KEY").toString("base64"), mode: "0400" },
    });
    expect(await readFile(join(dir, "run/creds/client.pem"), "utf8")).toBe("CERT");
    expect(await readFile(join(dir, "run/creds/client.key"), "utf8")).toBe("KEY");
    expect((await stat(join(dir, "run/creds/client.pem"))).mode & 0o777).toBe(0o400);
  });

  it("mirrors the container path so one `docker cp` carries the nesting", async () => {
    const dir = await stageFileMountsOnHost({
      "/etc/appstrate/certs/deep/ca.pem": {
        content_b64: Buffer.from("CA").toString("base64"),
        mode: "0444",
      },
    });
    expect(await readFile(join(dir, "etc/appstrate/certs/deep/ca.pem"), "utf8")).toBe("CA");
    // Staged parents are 0755, not 0777. Every one of them maps onto a REAL
    // runner directory (`/etc`, `/run`, `/usr/local/bin`), so if the archive's
    // directory mode is applied on extraction, 0777 world-writes them.
    expect((await stat(join(dir, "etc"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, "etc/appstrate"))).mode & 0o777).toBe(0o755);
  });

  it("stages the sticky dirs sticky and the root traversable", async () => {
    // The root entry is shipped as `docker cp <root>/. <id>:/`, whose tar
    // carries a `./` header. `mkdtemp` leaves it 0700: if directory modes are
    // applied on extraction, `/` becomes 0700 and every runner image (all five
    // run `USER runner:runner`, uid 1001) fails to traverse it.
    const dir = await stageFileMountsOnHost({
      "/tmp/session/cookie.txt": { content_b64: Buffer.from("C").toString("base64"), mode: "0400" },
      "/run/creds/k.pem": { content_b64: Buffer.from("K").toString("base64"), mode: "0400" },
    });
    expect((await stat(dir)).mode & 0o7777).toBe(0o755);
    // `/tmp` is 1777 in every base image; narrowing it to 0755 would break
    // every runtime that writes there. Only the world-writable half is
    // asserted: Bun's `fs.chmod` masks off every bit above 0o777, so the
    // sticky bit never lands (see `STICKY_STAGED_DIRS`).
    expect((await stat(join(dir, "tmp"))).mode & 0o777).toBe(0o777);
    expect((await stat(join(dir, "tmp/session"))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(dir, "run"))).mode & 0o7777).toBe(0o755);
  });

  it("refuses a mount under /usr or /workspace", async () => {
    // Both are real runner directories whose mode and ownership a staged
    // parent would carry: `/workspace` is the per-run volume SHARED with the
    // agent container (chowned 1001:1001 at create time), and `/usr` is the
    // image's own tree. Neither is a credential destination.
    for (const bad of ["/usr/local/bin/creds", "/workspace/token.json", "/workspace"]) {
      await expect(
        stageFileMountsOnHost({
          [bad]: { content_b64: Buffer.from("x").toString("base64"), mode: "0400" },
        }),
      ).rejects.toThrow(/unsafe container path/);
    }
  });

  it("decodes binary content losslessly", async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const dir = await stageFileMountsOnHost({
      "/run/creds/blob.bin": { content_b64: Buffer.from(bytes).toString("base64"), mode: "0400" },
    });
    const onDisk = await readFile(join(dir, "run/creds/blob.bin"));
    expect(onDisk.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(onDisk[i]).toBe(i);
  });

  it("refuses an unsafe container path", async () => {
    await expect(
      stageFileMountsOnHost({
        "/etc/passwd": { content_b64: Buffer.from("x").toString("base64"), mode: "0400" },
      }),
    ).rejects.toThrow(/unsafe container path/);
  });

  it("refuses a path that would escape the staging root on the host", async () => {
    // The platform-side resolver strips `..`, but the mirror is the first
    // scheme where a `..` that got through would write outside os.tmpdir().
    //
    // Which floor catches it MOVED, and the message says so: the container
    // path is canonicalized before it is judged now, so `/../../etc/cron.d/pwn`
    // clamps to `/etc/cron.d/pwn` and the safe-path floor refuses it one check
    // earlier, for naming a cron drop-in. That is the point of canonicalizing
    // — a spelling no longer decides a verdict — and it leaves the containment
    // check below as a third floor that nothing currently reaches. Keep it:
    // it is the only thing standing between a future non-canonical input and
    // a write outside the staging root.
    await expect(
      stageFileMountsOnHost({
        "/../../etc/cron.d/pwn": { content_b64: Buffer.from("x").toString("base64"), mode: "0400" },
      }),
    ).rejects.toThrow(/unsafe container path/);
  });
});

describe("docker adapter spawn — delivery.files copy", () => {
  it("ships every entry in ONE `docker cp` of the staged mirror into /", async () => {
    await withFakeDocker(async (calls) => {
      const adapter = await spawnWith(
        calls,
        spec({
          fileMounts: {
            "/run/creds/client.pem": {
              content_b64: Buffer.from("CERT").toString("base64"),
              mode: "0400",
            },
            "/run/creds/client.key": {
              content_b64: Buffer.from("KEY").toString("base64"),
              mode: "0400",
            },
          },
        }),
      );
      // No `docker exec` at all: the container is still in `Created` state at
      // this point, and the daemon answers 409 to exec against one that was
      // never started — the `mkdir -p` pre-create could never have run.
      expect(calls.some((c) => c.args[0] === "exec")).toBe(false);
      const mountCps = calls.filter(
        (c) => c.args[0] === "cp" && c.args[2] === `${FAKE_CONTAINER_ID}:/`,
      );
      expect(mountCps).toHaveLength(1);
      const stagedRoot = mountCps[0]!.args[1]!.replace(/\/\.$/, "");
      expect(await readFile(join(stagedRoot, "run/creds/client.pem"), "utf8")).toBe("CERT");
      expect(await readFile(join(stagedRoot, "run/creds/client.key"), "utf8")).toBe("KEY");
      await adapter.shutdown();
    });
  });
});
