// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/install.ts` parsing helpers.
 *
 * We only exercise the non-interactive branches (`raw !== undefined`).
 * The interactive clack `select`/`askText` paths require a real TTY
 * and are exercised by the e2e install smoke test in CI.
 *
 * Coverage targets the three safety-critical validations:
 *   - `resolveTier` rejects anything other than 0/1/2/3 (a stray `--tier
 *     4` must abort BEFORE `generateEnvForTier` asserts non-exhaustively).
 *   - `resolveDir` rejects newlines + NUL bytes so no downstream shell
 *     script / backup tool gets confused (see the threat model comment
 *     in install.ts).
 *   - `resolveDir` normalizes to an absolute path so the spawn layer
 *     in tier0/tier123 gets a stable cwd.
 */

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveTier,
  resolveDir,
  parsePort,
  resolveAppstratePort,
  resolveMinioConsolePort,
} from "../src/commands/install.ts";
import type { RunningComposeProject } from "../src/lib/install/tier123.ts";

describe("resolveTier", () => {
  it("accepts '0', '1', '2', '3' as literal strings", async () => {
    expect(await resolveTier("0")).toBe(0);
    expect(await resolveTier("1")).toBe(1);
    expect(await resolveTier("2")).toBe(2);
    expect(await resolveTier("3")).toBe(3);
  });

  it("rejects out-of-range values", async () => {
    await expect(resolveTier("4")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("-1")).rejects.toThrow(/Invalid --tier/);
  });

  it("rejects non-numeric values", async () => {
    await expect(resolveTier("standard")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("1.5")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("NaN")).rejects.toThrow(/Invalid --tier/);
  });

  it("throws a clear error when stdin is not a TTY and --tier is missing", async () => {
    // Regression for issue #184: `curl … | bash` bootstrap inherited a
    // closed pipe as stdin, so clack's `select` crashed silently. The
    // guard only fires when `deps.select` defaults to the real
    // `clack.select`; the DI tests below inject a stub and so exercise
    // the interactive branch regardless of TTY state.
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(resolveTier(undefined)).rejects.toThrow(/stdin is not a TTY/);
    await expect(resolveTier(undefined)).rejects.toThrow(/--tier/);
  });

  it("never invokes the Docker probe when --tier is provided", async () => {
    // Locks down the contract that the CI one-liner (`--tier 3`) never
    // spawns `docker info` — a regression here would change the byte-
    // identical CI install path into something that depends on daemon
    // availability (or daemon latency, via the probe's 3 s timeout).
    const probe = async () => {
      throw new Error("isDockerAvailable must not be called when --tier is provided");
    };
    for (const raw of ["0", "1", "2", "3"] as const) {
      const tier = await resolveTier(raw, {
        isDockerAvailable: probe,
        select: (async () => {
          throw new Error("select must not be called when --tier is provided");
        }) as unknown as typeof import("@clack/prompts").select,
        isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
        note: () => {
          throw new Error("note must not be called when --tier is provided");
        },
      });
      expect(tier).toBe(Number(raw) as 0 | 1 | 2 | 3);
    }
  });
});

describe("resolveTier (--yes / autoConfirm)", () => {
  // Regression suite for #199: under --yes the Docker-aware default is
  // returned WITHOUT calling `clack.select`. That bypass is the actual
  // fix — it means `setRawMode` never runs, so the Bun macOS keypress
  // regression (family of oven-sh/bun #6862, #7033, #24615, #5240,
  // #14483) can't trip the binary regardless of upstream fix status.
  // The tests lock that contract down: any future refactor that
  // accidentally reintroduces `select()` on the --yes path fails here.

  it("returns Tier 3 when Docker is available, without calling select", async () => {
    let selectCalls = 0;
    const select = (async () => {
      selectCalls += 1;
      return 0;
    }) as unknown as typeof import("@clack/prompts").select;
    let noteMsg: string | undefined;
    const tier = await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: (msg) => {
        noteMsg = String(msg);
      },
      isDockerAvailable: async () => true,
      autoConfirm: true,
    });
    expect(tier).toBe(3);
    expect(selectCalls).toBe(0);
    expect(noteMsg).toMatch(/Tier 3 selected automatically/i);
    expect(noteMsg).toMatch(/Docker detected/i);
  });

  it("returns Tier 0 when Docker is missing, without calling select", async () => {
    let selectCalls = 0;
    const select = (async () => {
      selectCalls += 1;
      return 0;
    }) as unknown as typeof import("@clack/prompts").select;
    let noteMsg: string | undefined;
    const tier = await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: (msg) => {
        noteMsg = String(msg);
      },
      isDockerAvailable: async () => false,
      autoConfirm: true,
    });
    expect(tier).toBe(0);
    expect(selectCalls).toBe(0);
    expect(noteMsg).toMatch(/Tier 0 selected automatically/i);
    expect(noteMsg).toMatch(/Docker not detected/i);
  });

  it("does not trip the stdin-is-not-a-TTY guard (curl|bash use case)", async () => {
    // The whole point of --yes is to work under `curl | bash` where stdin
    // is NOT a TTY. If a future refactor reintroduced the TTY guard on
    // this path, the bootstrap script would regress to issue #184.
    expect(process.stdin.isTTY).toBeFalsy();
    const tier = await resolveTier(undefined, {
      isDockerAvailable: async () => true,
      note: () => {},
      autoConfirm: true,
    });
    expect(tier).toBe(3);
  });

  it("still honors an explicit --tier argument under --yes (granular override wins)", async () => {
    // rustup convention: `-y --default-toolchain nightly` uses the
    // toolchain the user named, not the default. Our equivalent: the
    // per-field flag overrides the smart default.
    const probe = async () => {
      throw new Error("isDockerAvailable must not be called when --tier is provided");
    };
    for (const raw of ["0", "1", "2", "3"] as const) {
      const tier = await resolveTier(raw, {
        autoConfirm: true,
        isDockerAvailable: probe,
        select: (async () => {
          throw new Error("select must not be called when --tier is provided");
        }) as unknown as typeof import("@clack/prompts").select,
        isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
        note: () => {
          throw new Error("note must not be called when --tier is provided");
        },
      });
      expect(tier).toBe(Number(raw) as 0 | 1 | 2 | 3);
    }
  });
});

describe("resolveDir (--yes / autoConfirm)", () => {
  it("returns DEFAULT_INSTALL_DIR without prompting when --dir is missing", async () => {
    // Under --yes we must never enter askText — same setRawMode bypass
    // story as resolveTier. The returned path must be absolute so the
    // tier0/tier123 spawn layer gets a stable cwd.
    expect(process.stdin.isTTY).toBeFalsy();
    const out = await resolveDir(undefined, { autoConfirm: true });
    expect(out).toBe(resolve(join(process.env.HOME ?? "", "appstrate")));
    expect(out.startsWith("/")).toBe(true);
  });

  it("still honors --dir when both --dir and --yes are passed", async () => {
    const out = await resolveDir("/tmp/appstrate-custom", { autoConfirm: true });
    expect(out).toBe("/tmp/appstrate-custom");
  });

  it("still rejects malicious paths under --yes", async () => {
    // --yes does not disable the validation guard — a newline in --dir
    // is rejected regardless, so the downstream shell-safety invariants
    // hold even in the one-liner installer path.
    await expect(resolveDir("/tmp/bad\npath", { autoConfirm: true })).rejects.toThrow(
      /newlines or NUL/,
    );
  });
});

describe("resolveTier (interactive)", () => {
  /** Captures whatever options are passed into the fake `select`. */
  type SelectOpts = {
    initialValue?: number;
    options?: Array<{ value: number; label: string }>;
  };

  it("defaults to Tier 3 when Docker is available", async () => {
    let captured: SelectOpts | undefined;
    const select = (async (opts: SelectOpts) => {
      captured = opts;
      return opts.initialValue;
    }) as unknown as typeof import("@clack/prompts").select;
    const tier = await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: () => {},
      isDockerAvailable: async () => true,
    });
    expect(tier).toBe(3);
    expect(captured?.initialValue).toBe(3);
    expect(captured?.options?.[0]?.value).toBe(3);
    expect(captured?.options?.[0]?.label).toMatch(/recommended/i);
  });

  it("falls back to Tier 0 default when Docker is missing and surfaces a note", async () => {
    let captured: SelectOpts | undefined;
    let noteCalls = 0;
    const select = (async (opts: SelectOpts) => {
      captured = opts;
      return opts.initialValue;
    }) as unknown as typeof import("@clack/prompts").select;
    const tier = await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: (msg) => {
        noteCalls += 1;
        expect(msg).toMatch(/Docker not detected/i);
      },
      isDockerAvailable: async () => false,
    });
    expect(tier).toBe(0);
    expect(captured?.initialValue).toBe(0);
    expect(noteCalls).toBe(1);
  });

  it("returns whatever the user explicitly selects, regardless of default", async () => {
    const select = (async () => 2) as unknown as typeof import("@clack/prompts").select;
    const tier = await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: () => {},
      isDockerAvailable: async () => true,
    });
    expect(tier).toBe(2);
  });

  it("orders options Tier 3 → 2 → 1 → 0", async () => {
    let captured: SelectOpts | undefined;
    const select = (async (opts: SelectOpts) => {
      captured = opts;
      return 3;
    }) as unknown as typeof import("@clack/prompts").select;
    await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: () => {},
      isDockerAvailable: async () => true,
    });
    expect(captured?.options?.map((o) => o.value)).toEqual([3, 2, 1, 0]);
  });

  it("exits with 130 on cancel", async () => {
    const select = (async () =>
      Symbol("cancel-sentinel")) as unknown as typeof import("@clack/prompts").select;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(
        resolveTier(undefined, {
          select,
          isCancel: ((value: unknown) =>
            typeof value === "symbol") as unknown as typeof import("@clack/prompts").isCancel,
          note: () => {},
          isDockerAvailable: async () => true,
        }),
      ).rejects.toThrow("exit:130");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("resolveDir", () => {
  it("resolves a relative path to an absolute one", async () => {
    const out = await resolveDir("./my-install");
    expect(out).toBe(resolve("./my-install"));
    expect(out.startsWith("/")).toBe(true);
  });

  it("leaves an already-absolute path untouched except for normalization", async () => {
    const out = await resolveDir("/tmp/foo/../foo");
    expect(out).toBe("/tmp/foo");
  });

  it("rejects paths containing a newline", async () => {
    await expect(resolveDir("/tmp/bad\npath")).rejects.toThrow(/newlines or NUL/);
    await expect(resolveDir("/tmp/bad\rpath")).rejects.toThrow(/newlines or NUL/);
  });

  it("rejects paths containing a NUL byte", async () => {
    await expect(resolveDir("/tmp/bad\0path")).rejects.toThrow(/newlines or NUL/);
  });

  it("throws a clear error when stdin is not a TTY and --dir is missing", async () => {
    // Sibling of the resolveTier non-TTY case: `curl | bash -s -- --tier 3`
    // clears the tier prompt but would still crash on the askText() for
    // --dir. Same fail-fast contract — message must name --dir.
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(resolveDir(undefined)).rejects.toThrow(/stdin is not a TTY/);
    await expect(resolveDir(undefined)).rejects.toThrow(/--dir/);
  });
});

describe("parsePort", () => {
  it("returns the default when neither flag nor env var is set", () => {
    expect(parsePort(undefined, undefined, 3000, "--port")).toBe(3000);
  });

  it("prefers the flag value over the env value", () => {
    expect(parsePort("4000", "5000", 3000, "--port")).toBe(4000);
  });

  it("falls back to the env value when the flag is absent", () => {
    expect(parsePort(undefined, "5000", 3000, "--port")).toBe(5000);
  });

  it("treats an empty string like undefined (default)", () => {
    // Commander may hand us an empty string on `--port ""`; we'd rather
    // use the default than fail with a confusing "expected integer in
    // 1..65535" message.
    expect(parsePort("", "", 3000, "--port")).toBe(3000);
  });

  it("rejects non-integer values", () => {
    expect(() => parsePort("abc", undefined, 3000, "--port")).toThrow(/Invalid --port/);
    expect(() => parsePort("3000.5", undefined, 3000, "--port")).toThrow(/Invalid --port/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parsePort("0", undefined, 3000, "--port")).toThrow(/1\.\.65535/);
    expect(() => parsePort("-5", undefined, 3000, "--port")).toThrow(/1\.\.65535/);
    expect(() => parsePort("70000", undefined, 3000, "--port")).toThrow(/1\.\.65535/);
  });
});

describe("resolveAppstratePort (non-interactive preflight)", () => {
  const servers: Server[] = [];
  const originalEnvPort = process.env.APPSTRATE_PORT;
  const originalEnvMinio = process.env.APPSTRATE_MINIO_CONSOLE_PORT;

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    if (originalEnvPort === undefined) delete process.env.APPSTRATE_PORT;
    else process.env.APPSTRATE_PORT = originalEnvPort;
    if (originalEnvMinio === undefined) delete process.env.APPSTRATE_MINIO_CONSOLE_PORT;
    else process.env.APPSTRATE_MINIO_CONSOLE_PORT = originalEnvMinio;
  });

  it("returns the requested port when it is free", async () => {
    const port = await pickEphemeralPort();
    const out = await resolveAppstratePort(String(port), /* nonInteractive */ true);
    expect(out).toBe(port);
  });

  it("throws a helpful error when the port is taken (non-interactive)", async () => {
    const port = await holdEphemeralPort(servers);
    await expect(resolveAppstratePort(String(port), true)).rejects.toThrow(
      /Port \d+ is already in use.*APPSTRATE_PORT|--port/,
    );
  });

  it("honors APPSTRATE_PORT when --port is absent", async () => {
    const port = await pickEphemeralPort();
    process.env.APPSTRATE_PORT = String(port);
    const out = await resolveAppstratePort(undefined, true);
    expect(out).toBe(port);
  });
});

describe("resolveMinioConsolePort (non-interactive preflight)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
  });

  it("surfaces the MinIO label in the error message", async () => {
    const port = await holdEphemeralPort(servers);
    await expect(resolveMinioConsolePort(String(port), true)).rejects.toThrow(
      /MinIO console.*--minio-console-port|APPSTRATE_MINIO_CONSOLE_PORT/,
    );
  });
});

/**
 * Upgrade-path preflight behaviour. On a re-run the existing stack is
 * already bound to its ports — a bind-based probe would always report
 * them as in use, turning every `appstrate install` re-run into a
 * false-positive abort. These tests lock down the contract: on
 * upgrade with an existing `.env`, inherit the port and skip the
 * probe entirely.
 */
describe("resolveAppstratePort on upgrade (skip preflight, inherit from .env)", () => {
  const servers: Server[] = [];
  const originalEnvPort = process.env.APPSTRATE_PORT;

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    if (originalEnvPort === undefined) delete process.env.APPSTRATE_PORT;
    else process.env.APPSTRATE_PORT = originalEnvPort;
  });

  /** Build an ExistingInstall that looks like an active deployment (hasEnv=true). */
  function existingWith(existingEnv: Record<string, string>) {
    return { hasEnv: true, hasCompose: true, existingEnv };
  }

  it("returns the PORT from existing .env even when that port is held", async () => {
    // The whole point of the fix: a bound port on upgrade is NOT a
    // conflict — it's the existing install's own server. `ensurePortFree`
    // would reject it; we must not call it.
    const port = await holdEphemeralPort(servers);
    const out = await resolveAppstratePort(
      undefined,
      true,
      "upgrade",
      existingWith({ PORT: String(port) }),
    );
    expect(out).toBe(port);
  });

  it("falls back to default 3000 when PORT key is absent (secrets.ts elides defaults)", async () => {
    // `generateEnvForTier` doesn't write `PORT=3000` — default is
    // elided. An upgrade of a default-port install therefore has no
    // PORT key in the parsed `.env`; the effective port is the
    // default. Must NOT preflight: the existing stack is on :3000.
    const out = await resolveAppstratePort(undefined, true, "upgrade", existingWith({}));
    expect(out).toBe(3000);
  });

  it("falls back to default when the existing PORT value is invalid", async () => {
    // Corrupt `.env` (user hand-edit) must not crash the upgrade —
    // fall back to default and let compose up surface the real error.
    const out = await resolveAppstratePort(
      undefined,
      true,
      "upgrade",
      existingWith({ PORT: "not-a-number" }),
    );
    expect(out).toBe(3000);
  });

  it("ignores --port on upgrade (mergeEnv existing-wins semantics)", async () => {
    const port = await holdEphemeralPort(servers);
    // User passes --port 4000, but the existing .env has PORT=<held>.
    // mergeEnv would keep <held>, so we must too — returning 4000
    // here would bind the stack to a port the compose file won't use.
    const out = await resolveAppstratePort(
      "4000",
      true,
      "upgrade",
      existingWith({ PORT: String(port) }),
    );
    expect(out).toBe(port);
  });

  it("falls through to preflight when mode is fresh (default)", async () => {
    // Default argument for `mode` is "fresh" — sanity check that the
    // old two-arg call signature still hits the preflight path.
    const port = await holdEphemeralPort(servers);
    await expect(resolveAppstratePort(String(port), true)).rejects.toThrow(/already in use/);
  });

  it("PREFLIGHTS when mode is upgrade but hasEnv is false (stray compose file, no .env to inherit)", async () => {
    // `detectInstallMode` returns `upgrade` on `hasCompose` alone (it
    // also treats a half-installed dir as upgrade to avoid clobbering
    // the user's work). But without a `.env` there's nothing to
    // inherit: `mergeEnv({}, fresh) === fresh`, so the stack is about
    // to come up on fresh ports. We genuinely need the preflight.
    const port = await holdEphemeralPort(servers);
    await expect(
      resolveAppstratePort(String(port), true, "upgrade", {
        hasEnv: false,
        hasCompose: true,
        existingEnv: {},
      }),
    ).rejects.toThrow(/already in use/);
  });
});

/**
 * Cross-check with `docker compose ls` on docker tiers: the skip is
 * only safe when we can POSITIVELY confirm our own stack is running at
 * this dir. A `docker compose down` followed by a third-party squat on
 * the port must fall through to the preflight.
 */
describe("resolveAppstratePort upgrade cross-check (findRunningComposeProject)", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const originalEnvPort = process.env.APPSTRATE_PORT;

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (originalEnvPort === undefined) delete process.env.APPSTRATE_PORT;
    else process.env.APPSTRATE_PORT = originalEnvPort;
  });

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "appstrate-cli-port-"));
    dirs.push(d);
    return d;
  }

  function existingWith(existingEnv: Record<string, string>) {
    return { hasEnv: true, hasCompose: true, existingEnv };
  }

  /** Pre-canned `findRunningComposeProject` returning a fixed result. */
  function fakeFinder(result: RunningComposeProject | null) {
    return async (_name: string) => result;
  }

  it("skips preflight when the running compose project's configFiles match this dir", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    const out = await resolveAppstratePort(
      undefined,
      true,
      "upgrade",
      existingWith({ PORT: String(port) }),
      dir,
      "myproject",
      {
        findRunningComposeProject: fakeFinder({
          name: "myproject",
          configFiles: [join(dir, "docker-compose.yml")],
        }),
      },
    );
    expect(out).toBe(port);
  });

  it("PREFLIGHTS when the compose project is down (findRunning returns null) — third-party may have squatted the port", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    await expect(
      resolveAppstratePort(
        String(port),
        true,
        "upgrade",
        existingWith({ PORT: String(port) }),
        dir,
        "myproject",
        { findRunningComposeProject: fakeFinder(null) },
      ),
    ).rejects.toThrow(/already in use/);
  });

  it("PREFLIGHTS when the running project belongs to a DIFFERENT dir — never silently adopt a foreign stack's port", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    const otherDir = makeDir();
    await expect(
      resolveAppstratePort(
        String(port),
        true,
        "upgrade",
        existingWith({ PORT: String(port) }),
        dir,
        "myproject",
        {
          findRunningComposeProject: fakeFinder({
            name: "myproject",
            configFiles: [join(otherDir, "docker-compose.yml")],
          }),
        },
      ),
    ).rejects.toThrow(/already in use/);
  });

  it("skips preflight when projectName is undefined (tier 0) even if port is held", async () => {
    // Tier 0 has no compose project — no cross-check is possible. Fall
    // back to the legacy behaviour: trust hasEnv + inherited port.
    const port = await holdEphemeralPort(servers);
    const out = await resolveAppstratePort(
      undefined,
      true,
      "upgrade",
      existingWith({ PORT: String(port) }),
      undefined,
      undefined,
    );
    expect(out).toBe(port);
  });

  it("returns inherited (not $APPSTRATE_PORT) when env var diverges from existing .env", async () => {
    // The bug this branch targets: $APPSTRATE_PORT=4000 with PORT=3000
    // in .env must yield 3000, not silently honor the env var.
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    process.env.APPSTRATE_PORT = "4000";
    const out = await resolveAppstratePort(
      undefined,
      true,
      "upgrade",
      existingWith({ PORT: String(port) }),
      dir,
      "myproject",
      {
        findRunningComposeProject: fakeFinder({
          name: "myproject",
          configFiles: [join(dir, "docker-compose.yml")],
        }),
      },
    );
    expect(out).toBe(port);
  });
});

describe("resolveMinioConsolePort on upgrade (gated on MINIO_ROOT_PASSWORD presence)", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
  });

  function existingWith(existingEnv: Record<string, string>) {
    return { hasEnv: true, hasCompose: true, existingEnv };
  }

  it("skips preflight when MinIO was in the previous install", async () => {
    // Tier 3 → Tier 3 re-run: MINIO_ROOT_PASSWORD present → console
    // port is held by the existing MinIO → must skip preflight.
    const port = await holdEphemeralPort(servers);
    const out = await resolveMinioConsolePort(
      undefined,
      true,
      "upgrade",
      existingWith({ MINIO_ROOT_PASSWORD: "existing-secret", MINIO_CONSOLE_PORT: String(port) }),
    );
    expect(out).toBe(port);
  });

  it("inherits the MinIO default 9001 when MINIO_CONSOLE_PORT is absent", async () => {
    // Default port (9001) is elided by `generateEnvForTier`. With
    // MINIO_ROOT_PASSWORD present we know MinIO is running, so 9001
    // is held by us — skip preflight and return 9001.
    const out = await resolveMinioConsolePort(
      undefined,
      true,
      "upgrade",
      existingWith({ MINIO_ROOT_PASSWORD: "existing-secret" }),
    );
    expect(out).toBe(9001);
  });

  it("PREFLIGHTS on a tier 1 → tier 3 transition (MinIO is net-new)", async () => {
    // The existing install was tier 1 or 2 — no MINIO_ROOT_PASSWORD.
    // Adding MinIO for the first time means its console port must
    // actually be free; we don't get to trust `.env` here.
    const port = await holdEphemeralPort(servers);
    await expect(
      resolveMinioConsolePort(
        String(port),
        true,
        "upgrade",
        existingWith({ BETTER_AUTH_SECRET: "tier-1-secret" }),
      ),
    ).rejects.toThrow(/MinIO console/);
  });

  it("PREFLIGHTS when hasEnv is false (stray compose file, no .env to prove MinIO was present)", async () => {
    // Same edge case as the main resolver: `mode=upgrade` can fire on
    // hasCompose alone. Without a `.env` we can't claim MinIO was
    // running, so any port we pick must actually be free.
    const port = await holdEphemeralPort(servers);
    await expect(
      resolveMinioConsolePort(String(port), true, "upgrade", {
        hasEnv: false,
        hasCompose: true,
        existingEnv: {},
      }),
    ).rejects.toThrow(/MinIO console/);
  });

  it("ignores --minio-console-port on an existing-MinIO upgrade", async () => {
    const port = await holdEphemeralPort(servers);
    const out = await resolveMinioConsolePort(
      "9500",
      true,
      "upgrade",
      existingWith({ MINIO_ROOT_PASSWORD: "existing-secret", MINIO_CONSOLE_PORT: String(port) }),
    );
    expect(out).toBe(port);
  });
});

describe("resolveMinioConsolePort upgrade cross-check (findRunningComposeProject)", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const originalEnvMinio = process.env.APPSTRATE_MINIO_CONSOLE_PORT;

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (originalEnvMinio === undefined) delete process.env.APPSTRATE_MINIO_CONSOLE_PORT;
    else process.env.APPSTRATE_MINIO_CONSOLE_PORT = originalEnvMinio;
  });

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "appstrate-cli-minio-"));
    dirs.push(d);
    return d;
  }

  function existingWithMinio(extra: Record<string, string> = {}) {
    return {
      hasEnv: true,
      hasCompose: true,
      existingEnv: { MINIO_ROOT_PASSWORD: "existing-secret", ...extra },
    };
  }

  function fakeFinder(result: RunningComposeProject | null) {
    return async (_name: string) => result;
  }

  it("skips preflight when the running compose project's configFiles match this dir", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    const out = await resolveMinioConsolePort(
      undefined,
      true,
      "upgrade",
      existingWithMinio({ MINIO_CONSOLE_PORT: String(port) }),
      dir,
      "myproject",
      {
        findRunningComposeProject: fakeFinder({
          name: "myproject",
          configFiles: [join(dir, "docker-compose.yml")],
        }),
      },
    );
    expect(out).toBe(port);
  });

  it("PREFLIGHTS when the compose project is down (findRunning returns null)", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    await expect(
      resolveMinioConsolePort(
        String(port),
        true,
        "upgrade",
        existingWithMinio({ MINIO_CONSOLE_PORT: String(port) }),
        dir,
        "myproject",
        { findRunningComposeProject: fakeFinder(null) },
      ),
    ).rejects.toThrow(/MinIO console/);
  });

  it("PREFLIGHTS when the running project belongs to a DIFFERENT dir", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    const otherDir = makeDir();
    await expect(
      resolveMinioConsolePort(
        String(port),
        true,
        "upgrade",
        existingWithMinio({ MINIO_CONSOLE_PORT: String(port) }),
        dir,
        "myproject",
        {
          findRunningComposeProject: fakeFinder({
            name: "myproject",
            configFiles: [join(otherDir, "docker-compose.yml")],
          }),
        },
      ),
    ).rejects.toThrow(/MinIO console/);
  });

  it("skips preflight when projectName is undefined (no compose concept)", async () => {
    // MinIO is docker-only so this case is unlikely in practice, but
    // the resolver must stay consistent with resolveAppstratePort.
    const port = await holdEphemeralPort(servers);
    const out = await resolveMinioConsolePort(
      undefined,
      true,
      "upgrade",
      existingWithMinio({ MINIO_CONSOLE_PORT: String(port) }),
      undefined,
      undefined,
    );
    expect(out).toBe(port);
  });

  it("returns inherited when $APPSTRATE_MINIO_CONSOLE_PORT diverges from existing .env", async () => {
    const port = await holdEphemeralPort(servers);
    const dir = makeDir();
    process.env.APPSTRATE_MINIO_CONSOLE_PORT = "9500";
    const out = await resolveMinioConsolePort(
      undefined,
      true,
      "upgrade",
      existingWithMinio({ MINIO_CONSOLE_PORT: String(port) }),
      dir,
      "myproject",
      {
        findRunningComposeProject: fakeFinder({
          name: "myproject",
          configFiles: [join(dir, "docker-compose.yml")],
        }),
      },
    );
    expect(out).toBe(port);
  });
});

async function pickEphemeralPort(): Promise<number> {
  const srv = createServer();
  srv.unref();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function holdEphemeralPort(holders: Server[]): Promise<number> {
  const srv = createServer();
  srv.unref();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
  holders.push(srv);
  return port;
}
