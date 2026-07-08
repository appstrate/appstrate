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
  resolveBootstrapEmail,
  resolveAppUrl,
  assertLoopbackPortMatches,
  printBootstrapFollowup,
  postInstallBrowserUrl,
  resolveRunBackend,
  readRawRunAdapter,
  assertRunAdapterCompatibleWithTier,
  buildRunnerInstallArgs,
  firecrackerFollowupNote,
  resolveCliInvocation,
  runSameHostRunnerInstall,
  type RunBackendConfig,
  reconcileUpgradeTier,
} from "../src/commands/install.ts";
import type { RunningComposeProject } from "../src/lib/install/tier123.ts";

/** Fresh-install shape reused by the resolveAppUrl suite. */
const NO_EXISTING = { hasEnv: false, hasCompose: false, existingEnv: {} };

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

  it("returns Tier 2 when Docker is available, without calling select", async () => {
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
    expect(tier).toBe(2);
    expect(selectCalls).toBe(0);
    expect(noteMsg).toMatch(/Tier 2 selected automatically/i);
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
    expect(tier).toBe(2);
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
  it("returns defaultInstallDir() without prompting when --dir is missing", async () => {
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

  it("defaults to Tier 2 when Docker is available", async () => {
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
    expect(tier).toBe(2);
    expect(captured?.initialValue).toBe(2);
    expect(captured?.options?.[1]?.value).toBe(2);
    expect(captured?.options?.[1]?.label).toMatch(/recommended/i);
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
    const select = (async () => 3) as unknown as typeof import("@clack/prompts").select;
    const tier = await resolveTier(undefined, {
      select,
      isCancel: (() => false) as unknown as typeof import("@clack/prompts").isCancel,
      note: () => {},
      isDockerAvailable: async () => true,
    });
    expect(tier).toBe(3);
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

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    if (originalEnvPort === undefined) delete process.env.APPSTRATE_PORT;
    else process.env.APPSTRATE_PORT = originalEnvPort;
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

  it("documents the correct `curl | VAR=N bash` syntax in the strict error", async () => {
    // Regression guard for the shell-scoping gotcha that triggered this
    // whole change: users reach for `APPSTRATE_PORT=N curl … | bash`,
    // which sets the var for curl only — the piped bash doesn't see it.
    // The error message must name the working syntax explicitly, or the
    // user has no way to discover why their "override" was ignored.
    const port = await holdEphemeralPort(servers);
    await expect(resolveAppstratePort(String(port), true)).rejects.toThrow(
      /curl[^\n]*\|[^\n]*APPSTRATE_PORT=[^\n]*bash/,
    );
  });

  it("honors APPSTRATE_PORT when --port is absent", async () => {
    const port = await pickEphemeralPort();
    process.env.APPSTRATE_PORT = String(port);
    const out = await resolveAppstratePort(undefined, true);
    expect(out).toBe(port);
  });
});

/**
 * Auto-pick mode (wired from `--yes` by `installCommand`). The one-liner
 * installer's contract is "paste into a terminal, get a working
 * Appstrate" — the single most common snag is a stale dev server still
 * bound to :3000 from an earlier session. Under `--yes` we soften the
 * port conflict into "use the next free port" instead of failing fast.
 *
 * Explicit scripted installs (`--tier N` without `--yes`) keep
 * the strict semantics so CI/automation still surfaces the drift.
 */
describe("resolveAppstratePort auto-pick (--yes path)", () => {
  const servers: Server[] = [];
  const originalEnvPort = process.env.APPSTRATE_PORT;

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    if (originalEnvPort === undefined) delete process.env.APPSTRATE_PORT;
    else process.env.APPSTRATE_PORT = originalEnvPort;
  });

  it("picks the next free port when the requested one is held", async () => {
    const held = await holdEphemeralPort(servers);
    const out = await resolveAppstratePort(
      String(held),
      /* nonInteractive */ true,
      "fresh",
      undefined,
      undefined,
      undefined,
      { autoPick: true },
    );
    // The concrete picked value depends on kernel port allocation, but
    // it must be free (not the held port) and above the held port
    // (scan probes upward only).
    expect(out).toBeGreaterThan(held);
    expect(out).toBeLessThanOrEqual(65535);
  });

  it("returns the requested port unchanged when it is free (no drift)", async () => {
    // Auto-pick must be a conflict-only fallback, never a silent drift
    // when the user's chosen port works. A regression here would break
    // users who pass `--yes --port 4000` with :4000 free.
    const port = await pickEphemeralPort();
    const out = await resolveAppstratePort(
      String(port),
      true,
      "fresh",
      undefined,
      undefined,
      undefined,
      { autoPick: true },
    );
    expect(out).toBe(port);
  });

  it("scans past two contiguous held ports (the common stale-dev-server shape)", async () => {
    // Locks down the "probe upward in a loop" contract: if port N is
    // held AND port N+1 is held, the resolver must land on N+2. Catches
    // a regression where findNextFreePort only checks the very next slot.
    const first = await holdEphemeralPort(servers);
    const second = await tryHoldSpecificPort(servers, first + 1);
    if (second === null) {
      // Adjacent slot is busy for an unrelated reason — skip rather
      // than assert on OS-dependent allocation we don't control.
      return;
    }
    const out = await resolveAppstratePort(
      String(first),
      true,
      "fresh",
      undefined,
      undefined,
      undefined,
      { autoPick: true },
    );
    expect(out).toBeGreaterThan(second);
  });

  it("is off by default — omitting autoPick preserves strict fail-fast (--tier N path)", async () => {
    const port = await holdEphemeralPort(servers);
    // No `{ autoPick: … }` in deps → explicit --tier scripted install
    // keeps the "error loudly" behaviour CI relies on.
    await expect(resolveAppstratePort(String(port), true)).rejects.toThrow(/already in use/);
  });

  it("autoPick: false is explicitly treated as disabled (not coerced to truthy)", async () => {
    const port = await holdEphemeralPort(servers);
    await expect(
      resolveAppstratePort(String(port), true, "fresh", undefined, undefined, undefined, {
        autoPick: false,
      }),
    ).rejects.toThrow(/already in use/);
  });

  it("still honors APPSTRATE_PORT when auto-picking (env var sets the starting point)", async () => {
    // The env var defines the USER's intent. Auto-pick only kicks in if
    // THAT port is busy. If the user set APPSTRATE_PORT=<free port>,
    // they must get that exact port — no drift, no log noise.
    const port = await pickEphemeralPort();
    process.env.APPSTRATE_PORT = String(port);
    const out = await resolveAppstratePort(
      undefined,
      true,
      "fresh",
      undefined,
      undefined,
      undefined,
      { autoPick: true },
    );
    expect(out).toBe(port);
  });

  it("does not trigger in interactive mode (autoPick is non-interactive only)", async () => {
    // autoPick is gated on nonInteractive=true INSIDE ensurePortFree —
    // passing `autoPick: true` under nonInteractive=false must fall
    // through to the interactive prompt branch, never silently drift
    // to a different port. Under this test harness stdin is not a TTY,
    // so the interactive askText rejects — that rejection is our proof
    // that auto-pick did NOT take over. The key negative assertion is
    // "did not resolve to held+N"; any rejection satisfies that.
    const port = await holdEphemeralPort(servers);
    await expect(
      resolveAppstratePort(
        String(port),
        /* nonInteractive */ false,
        "fresh",
        undefined,
        undefined,
        undefined,
        { autoPick: true },
      ),
    ).rejects.toThrow();
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

/**
 * Attempt to bind `port` specifically — returns the port on success,
 * or `null` if something else has claimed it in the tiny window
 * between our ephemeral pick and this follow-up bind. Used to build
 * "two contiguous busy ports" scenarios without retrying forever when
 * the kernel refuses to cooperate on a given slot.
 */
async function tryHoldSpecificPort(holders: Server[], port: number): Promise<number | null> {
  const srv = createServer();
  srv.unref();
  return new Promise<number | null>((resolve) => {
    srv.once("error", () => {
      try {
        srv.close();
      } catch {
        // already closed
      }
      resolve(null);
    });
    srv.once("listening", () => {
      holders.push(srv);
      resolve(port);
    });
    try {
      srv.listen(port, "0.0.0.0");
    } catch {
      resolve(null);
    }
  });
}

describe("resolveBootstrapEmail (issue #228) — non-interactive paths", () => {
  // Snapshot the env vars we touch so other test files are unaffected.
  const SNAPSHOT = {
    APPSTRATE_BOOTSTRAP_OWNER_EMAIL: process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL,
    APPSTRATE_BOOTSTRAP_ORG_NAME: process.env.APPSTRATE_BOOTSTRAP_ORG_NAME,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(SNAPSHOT)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns the env var when APPSTRATE_BOOTSTRAP_OWNER_EMAIL is set (curl|bash IaC path)", async () => {
    process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    const result = await resolveBootstrapEmail({
      tier: 3,
      mode: "fresh",
      nonInteractive: true,
    });
    expect(result).toEqual({ bootstrapOwnerEmail: "admin@acme.com" });
  });

  it("forwards APPSTRATE_BOOTSTRAP_ORG_NAME when set alongside the email", async () => {
    process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    process.env.APPSTRATE_BOOTSTRAP_ORG_NAME = "Acme HQ";
    const result = await resolveBootstrapEmail({
      tier: 3,
      mode: "fresh",
      nonInteractive: true,
    });
    expect(result).toEqual({
      bootstrapOwnerEmail: "admin@acme.com",
      bootstrapOrgName: "Acme HQ",
    });
  });

  it("env var wins on every tier (Tier 0 IaC pass-through)", async () => {
    process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    const result = await resolveBootstrapEmail({
      tier: 0,
      mode: "fresh",
      nonInteractive: true,
    });
    expect(result.bootstrapOwnerEmail).toBe("admin@acme.com");
  });

  it("env var wins on upgrade too (operator can re-impose closed mode declaratively)", async () => {
    process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL = "admin@acme.com";
    const result = await resolveBootstrapEmail({
      tier: 3,
      mode: "upgrade",
      nonInteractive: true,
    });
    expect(result.bootstrapOwnerEmail).toBe("admin@acme.com");
  });

  it("throws when APPSTRATE_BOOTSTRAP_OWNER_EMAIL is malformed (fail-fast at install)", async () => {
    process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL = "not-an-email";
    await expect(
      resolveBootstrapEmail({ tier: 3, mode: "fresh", nonInteractive: true }),
    ).rejects.toThrow(/not a valid email/);
  });

  it("returns a bootstrap token on non-interactive Tier ≥ 1 fresh install without env var (#344)", async () => {
    delete process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL;
    const result = await resolveBootstrapEmail({
      tier: 3,
      mode: "fresh",
      nonInteractive: true,
    });
    expect(result.bootstrapOwnerEmail).toBeUndefined();
    expect(result.bootstrapToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → base64url is ~43 chars (32*4/3 with padding stripped).
    expect(result.bootstrapToken!.length).toBeGreaterThanOrEqual(40);
    expect(result.bootstrapToken!.length).toBeLessThanOrEqual(64);
  });

  it("generates a fresh token on each call (entropy not memoized)", async () => {
    delete process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL;
    const a = await resolveBootstrapEmail({ tier: 3, mode: "fresh", nonInteractive: true });
    const b = await resolveBootstrapEmail({ tier: 3, mode: "fresh", nonInteractive: true });
    expect(a.bootstrapToken).not.toBe(b.bootstrapToken);
  });

  it("returns empty (open mode) on non-interactive Tier 0 fresh install (local dev)", async () => {
    delete process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL;
    const result = await resolveBootstrapEmail({
      tier: 0,
      mode: "fresh",
      nonInteractive: true,
    });
    expect(result).toEqual({});
  });

  it("returns empty on upgrade without env var (mergeEnv preserves existing .env)", async () => {
    delete process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL;
    const result = await resolveBootstrapEmail({
      tier: 3,
      mode: "upgrade",
      nonInteractive: false,
    });
    expect(result).toEqual({});
  });

  it("returns empty on Tier 0 interactive (local dev — closed mode irrelevant)", async () => {
    delete process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL;
    const result = await resolveBootstrapEmail({
      tier: 0,
      mode: "fresh",
      nonInteractive: false,
    });
    expect(result).toEqual({});
  });

  it("trims whitespace from env-var values before validating", async () => {
    process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL = "  admin@acme.com  ";
    const result = await resolveBootstrapEmail({
      tier: 3,
      mode: "fresh",
      nonInteractive: true,
    });
    expect(result.bootstrapOwnerEmail).toBe("admin@acme.com");
  });
});

describe("printBootstrapFollowup (issue #228) — post-install action", () => {
  // Captures clack.note's two args via DI so we don't have to spy on stdout.
  function makeCapture() {
    const calls: Array<{ message: string; title?: string }> = [];
    return {
      calls,
      note: (message: string, title?: string) => calls.push({ message, title }),
    };
  }

  it("renders nothing when bootstrap email is absent (open-mode install)", () => {
    const cap = makeCapture();
    printBootstrapFollowup("http://localhost:3000", {}, cap.note);
    expect(cap.calls).toHaveLength(0);
  });

  it("renders the action note when bootstrap email is set", () => {
    const cap = makeCapture();
    printBootstrapFollowup(
      "http://localhost:3000",
      { bootstrapOwnerEmail: "admin@acme.com" },
      cap.note,
    );
    expect(cap.calls).toHaveLength(1);
    const { message, title } = cap.calls[0]!;
    expect(title).toContain("create your owner account");
    expect(message).toContain("http://localhost:3000/register");
    expect(message).toContain("admin@acme.com");
    expect(message).toContain("pre-filled and locked");
    // Default org name surfaces when not provided.
    expect(message).toContain('"Default"');
  });

  it("uses the configured bootstrapOrgName when set", () => {
    const cap = makeCapture();
    printBootstrapFollowup(
      "http://localhost:3000",
      { bootstrapOwnerEmail: "admin@acme.com", bootstrapOrgName: "Acme HQ" },
      cap.note,
    );
    expect(cap.calls[0]!.message).toContain('"Acme HQ"');
    expect(cap.calls[0]!.message).not.toContain('"Default"');
  });

  it("respects the appUrl argument verbatim (alternate ports / hosts)", () => {
    const cap = makeCapture();
    printBootstrapFollowup(
      "http://appstrate.acme.com",
      { bootstrapOwnerEmail: "admin@acme.com" },
      cap.note,
    );
    expect(cap.calls[0]!.message).toContain("http://appstrate.acme.com/register");
    expect(cap.calls[0]!.message).not.toContain("localhost");
  });
});

describe("postInstallBrowserUrl — post-install browser deep-link", () => {
  it("opens /register for a named-owner install (email pre-filled server-side)", () => {
    expect(
      postInstallBrowserUrl("http://localhost:3000", { bootstrapOwnerEmail: "admin@acme.com" }),
    ).toBe("http://localhost:3000/register");
  });

  it("opens /register for an open-mode install (no email, no token)", () => {
    expect(postInstallBrowserUrl("http://localhost:3000", {})).toBe(
      "http://localhost:3000/register",
    );
  });

  it("keeps the root landing for a bootstrap-token install (claim flow at /claim)", () => {
    expect(postInstallBrowserUrl("http://localhost:3000", { bootstrapToken: "tok_abc123" })).toBe(
      "http://localhost:3000",
    );
  });

  it("respects the localUrl argument verbatim (alternate ports)", () => {
    expect(postInstallBrowserUrl("http://localhost:3001", {})).toBe(
      "http://localhost:3001/register",
    );
  });
});

// ─── resolveRunBackend (Firecracker execution-backend option) ─────────

type ClackSelect = typeof import("@clack/prompts").select;
type ClackIsCancel = typeof import("@clack/prompts").isCancel;
type AskText = typeof import("../src/lib/ui.ts").askText;

const asSelect = (fn: (opts: { message: string }) => Promise<unknown>): ClackSelect =>
  fn as unknown as ClackSelect;
const noCancel = (() => false) as unknown as ClackIsCancel;

describe("resolveRunBackend — adapter selection", () => {
  it("defaults to docker in non-interactive mode with no flags", async () => {
    const cfg = await resolveRunBackend({ appPort: 3000, nonInteractive: true }, {});
    expect(cfg).toEqual({ adapter: "docker" });
  });

  it("honors --run-adapter docker explicitly (zero firecracker config)", async () => {
    const cfg = await resolveRunBackend(
      { runAdapter: "docker", appPort: 3000, nonInteractive: true },
      {},
    );
    expect(cfg).toEqual({ adapter: "docker" });
  });

  it("rejects an invalid --run-adapter value", async () => {
    await expect(
      resolveRunBackend({ runAdapter: "podman", appPort: 3000, nonInteractive: true }, {}),
    ).rejects.toThrow(/Invalid --run-adapter/);
  });

  it("reads APPSTRATE_RUN_ADAPTER as a fallback", async () => {
    const prev = process.env.APPSTRATE_RUN_ADAPTER;
    process.env.APPSTRATE_RUN_ADAPTER = "firecracker";
    try {
      const cfg = await resolveRunBackend(
        { hostIp: "10.0.0.5", appPort: 3000, nonInteractive: true },
        { generateToken: () => "generated-token-abcdef1234" },
      );
      expect(cfg.adapter).toBe("firecracker");
    } finally {
      if (prev === undefined) delete process.env.APPSTRATE_RUN_ADAPTER;
      else process.env.APPSTRATE_RUN_ADAPTER = prev;
    }
  });
});

describe("assertRunAdapterCompatibleWithTier (tier 0 × firecracker conflict)", () => {
  it("rejects an explicit firecracker request on tier 0", () => {
    expect(() => assertRunAdapterCompatibleWithTier(0, "firecracker")).toThrow(
      /--run-adapter firecracker requires a Docker tier \(1-3\); tier 0 runs agents in-process\./,
    );
  });

  it("stays silent on tier 0 when no adapter was requested (default behavior)", () => {
    expect(() => assertRunAdapterCompatibleWithTier(0, undefined)).not.toThrow();
  });

  it("allows docker on tier 0 and firecracker on Docker tiers", () => {
    expect(() => assertRunAdapterCompatibleWithTier(0, "docker")).not.toThrow();
    expect(() => assertRunAdapterCompatibleWithTier(1, "firecracker")).not.toThrow();
    expect(() => assertRunAdapterCompatibleWithTier(2, "firecracker")).not.toThrow();
    expect(() => assertRunAdapterCompatibleWithTier(3, "firecracker")).not.toThrow();
  });

  it("fires on an env-only APPSTRATE_RUN_ADAPTER=firecracker request via readRawRunAdapter", () => {
    const prev = process.env.APPSTRATE_RUN_ADAPTER;
    process.env.APPSTRATE_RUN_ADAPTER = "firecracker";
    try {
      expect(() => assertRunAdapterCompatibleWithTier(0, readRawRunAdapter(undefined))).toThrow(
        /requires a Docker tier/,
      );
    } finally {
      if (prev === undefined) delete process.env.APPSTRATE_RUN_ADAPTER;
      else process.env.APPSTRATE_RUN_ADAPTER = prev;
    }
  });

  it("readRawRunAdapter: flag wins over env, blank/whitespace normalizes to undefined", () => {
    const prev = process.env.APPSTRATE_RUN_ADAPTER;
    process.env.APPSTRATE_RUN_ADAPTER = "firecracker";
    try {
      expect(readRawRunAdapter("docker")).toBe("docker");
      expect(readRawRunAdapter(undefined)).toBe("firecracker");
      process.env.APPSTRATE_RUN_ADAPTER = "  ";
      expect(readRawRunAdapter(undefined)).toBeUndefined();
      expect(readRawRunAdapter("")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.APPSTRATE_RUN_ADAPTER;
      else process.env.APPSTRATE_RUN_ADAPTER = prev;
    }
  });
});

describe("resolveRunBackend — non-interactive firecracker validation matrix", () => {
  it("throws when neither --runner-url nor --host-ip is provided", async () => {
    await expect(
      resolveRunBackend({ runAdapter: "firecracker", appPort: 3000, nonInteractive: true }, {}),
    ).rejects.toThrow(/requires either/);
  });

  it("throws when --runner-url is given without --runner-token", async () => {
    await expect(
      resolveRunBackend(
        {
          runAdapter: "firecracker",
          runnerUrl: "http://10.0.0.9:3100",
          appPort: 3000,
          nonInteractive: true,
        },
        {},
      ),
    ).rejects.toThrow(/--runner-token/);
  });

  it("rejects a too-short --runner-token", async () => {
    await expect(
      resolveRunBackend(
        {
          runAdapter: "firecracker",
          hostIp: "10.0.0.5",
          runnerToken: "short",
          appPort: 3000,
          nonInteractive: true,
        },
        {},
      ),
    ).rejects.toThrow(/at least 16 characters/);
  });

  it("rejects a non-IPv4 --host-ip", async () => {
    await expect(
      resolveRunBackend(
        {
          runAdapter: "firecracker",
          hostIp: "my-host.local",
          appPort: 3000,
          nonInteractive: true,
        },
        { generateToken: () => "x".repeat(16) },
      ),
    ).rejects.toThrow(/IPv4 literal/);
  });

  it("rejects a non-IPv4 --runner-url", async () => {
    await expect(
      resolveRunBackend(
        {
          runAdapter: "firecracker",
          runnerUrl: "http://runner.local:3100",
          runnerToken: "x".repeat(16),
          appPort: 3000,
          nonInteractive: true,
        },
        {},
      ),
    ).rejects.toThrow(/must be http\(s\):\/\/<IPv4>/);
  });

  it("rejects an out-of-range-octet --runner-url (shared IPv4 validator)", async () => {
    // The old `IPV4_URL_RE` regex accepted these dotted-quad-shaped hosts;
    // the shared parseIpv4HttpUrl (like the daemon) range-checks each octet.
    for (const runnerUrl of ["http://300.0.0.1:3100", "http://256.256.256.256:3000"]) {
      await expect(
        resolveRunBackend(
          {
            runAdapter: "firecracker",
            runnerUrl,
            runnerToken: "x".repeat(16),
            appPort: 3000,
            nonInteractive: true,
          },
          {},
        ),
      ).rejects.toThrow(/must be http\(s\):\/\/<IPv4>/);
    }
  });
});

describe("resolveRunBackend — firecracker same-host", () => {
  it("uses the unix-socket runner URL and still builds the LAN platform URL from --host-ip", async () => {
    const cfg = await resolveRunBackend(
      { runAdapter: "firecracker", hostIp: "10.0.0.5", appPort: 8080, nonInteractive: true },
      { generateToken: () => "generated-token-abcdef1234" },
    );
    expect(cfg).toEqual({
      adapter: "firecracker",
      // Same-host = UDS: no TCP port, no plaintext wire — the beta.38
      // fail-closed http-to-non-loopback guard has nothing to refuse.
      runnerUrl: "unix:///run/appstrate-runner/runner.sock",
      token: "generated-token-abcdef1234",
      tokenSource: "generated",
      topology: "same-host",
      // hostIp is STILL collected: guests reach the platform over the LAN
      // (platformUrl) — only the platform↔daemon leg moved onto the socket.
      hostIp: "10.0.0.5",
      platformUrl: "http://10.0.0.5:8080",
    } satisfies RunBackendConfig);
  });

  it("honors an explicit --runner-token (>=16 chars)", async () => {
    const cfg = await resolveRunBackend(
      {
        runAdapter: "firecracker",
        hostIp: "10.0.0.5",
        runnerToken: "y".repeat(20),
        appPort: 3000,
        nonInteractive: true,
      },
      {},
    );
    if (cfg.adapter !== "firecracker") throw new Error("expected firecracker");
    expect(cfg.token).toBe("y".repeat(20));
    expect(cfg.tokenSource).toBe("flag");
  });
});

describe("resolveRunBackend — firecracker remote", () => {
  it("uses --runner-url (trailing slash stripped) + this-host detected IP for platform-url", async () => {
    const cfg = await resolveRunBackend(
      {
        runAdapter: "firecracker",
        runnerUrl: "http://10.0.0.9:3100/",
        runnerToken: "remote-token-abcdef1234",
        appPort: 3000,
        nonInteractive: true,
      },
      { detectLanIpv4: () => "192.168.1.20" },
    );
    if (cfg.adapter !== "firecracker") throw new Error("expected firecracker");
    expect(cfg.topology).toBe("remote");
    expect(cfg.runnerUrl).toBe("http://10.0.0.9:3100");
    expect(cfg.token).toBe("remote-token-abcdef1234");
    expect(cfg.tokenSource).toBe("flag");
    expect(cfg.platformUrl).toBe("http://192.168.1.20:3000");
  });

  it("falls back to a <this-host-ip> placeholder when LAN detection fails", async () => {
    const cfg = await resolveRunBackend(
      {
        runAdapter: "firecracker",
        runnerUrl: "http://10.0.0.9:3100",
        runnerToken: "remote-token-abcdef1234",
        appPort: 3000,
        nonInteractive: true,
      },
      { detectLanIpv4: () => null },
    );
    if (cfg.adapter !== "firecracker") throw new Error("expected firecracker");
    expect(cfg.hostIp).toBe("");
    expect(cfg.platformUrl).toBe("http://<this-host-ip>:3000");
  });
});

describe("resolveRunBackend — interactive prompts", () => {
  it("prompts for adapter + same-host IP, prefilling the detected LAN IP", async () => {
    const prompts: string[] = [];
    const askText = (async (msg: string, initial?: string) => {
      prompts.push(`${msg}::${initial ?? ""}`);
      return initial ?? "";
    }) as unknown as AskText;
    const cfg = await resolveRunBackend(
      { appPort: 3000, nonInteractive: false },
      {
        select: asSelect(async (opts) =>
          opts.message.toLowerCase().includes("backend") ? "firecracker" : "same-host",
        ),
        isCancel: noCancel,
        askText,
        detectLanIpv4: () => "10.1.2.3",
        generateToken: () => "gen-token-abcdef123456",
      },
    );
    if (cfg.adapter !== "firecracker") throw new Error("expected firecracker");
    expect(cfg.topology).toBe("same-host");
    expect(cfg.hostIp).toBe("10.1.2.3");
    expect(prompts.some((p) => p.endsWith("::10.1.2.3"))).toBe(true);
  });
});

describe("runner-install command builder + follow-up", () => {
  it("resolveCliInvocation returns the binary path for a compiled build", () => {
    expect(
      resolveCliInvocation("/usr/local/bin/appstrate", ["/usr/local/bin/appstrate", "install"]),
    ).toEqual(["/usr/local/bin/appstrate"]);
  });

  it("resolveCliInvocation prepends the runtime + entry script under bun/node", () => {
    expect(
      resolveCliInvocation("/opt/homebrew/bin/bun", [
        "/opt/homebrew/bin/bun",
        "/repo/apps/cli/src/cli.ts",
        "install",
      ]),
    ).toEqual(["/opt/homebrew/bin/bun", "/repo/apps/cli/src/cli.ts"]);
  });

  it("buildRunnerInstallArgs carries --platform-url, --token, and the UDS --socket", () => {
    const args = buildRunnerInstallArgs(
      ["/usr/local/bin/appstrate"],
      "http://10.0.0.5:3000",
      "the-token",
    );
    expect(args).toEqual([
      "/usr/local/bin/appstrate",
      "runner",
      "install",
      "--platform-url",
      "http://10.0.0.5:3000",
      "--token",
      "the-token",
      "--socket",
      "/run/appstrate-runner/runner.sock",
      "--yes",
    ]);
  });

  it("firecrackerFollowupNote (remote) prints the one-liner with platform-url + token", () => {
    const note = firecrackerFollowupNote({
      adapter: "firecracker",
      runnerUrl: "http://10.0.0.9:3100",
      token: "pairing-token-123456",
      tokenSource: "generated",
      topology: "remote",
      hostIp: "192.168.1.20",
      platformUrl: "http://192.168.1.20:3000",
    });
    expect(note).toContain("curl -fsSL https://get.appstrate.dev/runner");
    expect(note).toContain("--platform-url http://192.168.1.20:3000");
    expect(note).toContain("--token pairing-token-123456");
    expect(note).toContain("appstrate runner status");
  });

  it("firecrackerFollowupNote (same-host) explains the socket + bind-mount, no curl one-liner", () => {
    const note = firecrackerFollowupNote({
      adapter: "firecracker",
      runnerUrl: "unix:///run/appstrate-runner/runner.sock",
      token: "tok-123456",
      tokenSource: "generated",
      topology: "same-host",
      hostIp: "10.0.0.5",
      platformUrl: "http://10.0.0.5:3000",
    });
    expect(note).not.toContain("curl -fsSL");
    expect(note).toContain("unix:///run/appstrate-runner/runner.sock");
    expect(note).toContain("bind-mount");
    expect(note).toContain("/run/appstrate-runner");
    expect(note).toContain("appstrate runner logs -f");
  });
});

describe("runSameHostRunnerInstall", () => {
  const rb = {
    adapter: "firecracker",
    runnerUrl: "unix:///run/appstrate-runner/runner.sock",
    token: "pairing-token-123456",
    tokenSource: "generated",
    topology: "same-host",
    hostIp: "10.0.0.5",
    platformUrl: "http://10.0.0.5:3000",
  } satisfies RunBackendConfig;

  it("interactive + exit 0: spawns sudo in UDS mode, no warning, no manual-command note", async () => {
    const runCalls: Array<{ cmd: string; args: string[] }> = [];
    const notes: string[] = [];
    const warns: string[] = [];
    await runSameHostRunnerInstall(rb, {
      nonInteractive: false,
      cliInvocation: ["/usr/local/bin/appstrate"],
      run: async (cmd, args) => {
        runCalls.push({ cmd, args });
        return { ok: true, exitCode: 0 };
      },
      note: (message) => notes.push(message),
      logInfo: () => {},
      logWarn: (message) => warns.push(message),
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.cmd).toBe("sudo");
    // Same-host installs the daemon in UDS mode — the sudo argv carries the
    // canonical socket so the daemon matches the unix:// URL in the .env.
    const argv = runCalls[0]?.args ?? [];
    expect(argv).toContain("--socket");
    expect(argv[argv.indexOf("--socket") + 1]).toBe("/run/appstrate-runner/runner.sock");
    expect(warns).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it("interactive + non-zero exit: warns and prints the manual sudo command with platform-url + token", async () => {
    const warns: string[] = [];
    await runSameHostRunnerInstall(rb, {
      nonInteractive: false,
      cliInvocation: ["/usr/local/bin/appstrate"],
      run: async () => ({ ok: false, exitCode: 3 }),
      note: () => {},
      logInfo: () => {},
      logWarn: (message) => warns.push(message),
    });
    expect(warns).toHaveLength(1);
    const warning = warns[0] ?? "";
    expect(warning).toContain("sudo /usr/local/bin/appstrate runner install");
    expect(warning).toContain("--platform-url http://10.0.0.5:3000");
    expect(warning).toContain("--token pairing-token-123456");
    expect(warning).toContain("--socket /run/appstrate-runner/runner.sock");
  });

  it("non-interactive: never spawns, prints the manual sudo command instead", async () => {
    const runCalls: string[] = [];
    const notes: string[] = [];
    await runSameHostRunnerInstall(rb, {
      nonInteractive: true,
      cliInvocation: ["/usr/local/bin/appstrate"],
      run: async (cmd) => {
        runCalls.push(cmd);
        return { ok: true, exitCode: 0 };
      },
      note: (message) => notes.push(message),
      logInfo: () => {},
      logWarn: () => {},
    });
    expect(runCalls).toHaveLength(0);
    expect(notes).toHaveLength(1);
    const note = notes[0] ?? "";
    expect(note).toContain("sudo /usr/local/bin/appstrate runner install");
    expect(note).toContain("--platform-url http://10.0.0.5:3000");
    expect(note).toContain("--token pairing-token-123456");
    expect(note).toContain("--socket /run/appstrate-runner/runner.sock");
  });
});

describe("resolveAppUrl (issue #822) — non-interactive paths", () => {
  const SNAPSHOT = { APPSTRATE_APP_URL: process.env.APPSTRATE_APP_URL };
  afterEach(() => {
    if (SNAPSHOT.APPSTRATE_APP_URL === undefined) delete process.env.APPSTRATE_APP_URL;
    else process.env.APPSTRATE_APP_URL = SNAPSHOT.APPSTRATE_APP_URL;
  });

  const FRESH = { mode: "fresh" as const, existing: NO_EXISTING, nonInteractive: true };

  it("defaults to http://localhost:<port> when nothing is expressed", async () => {
    expect(await resolveAppUrl(undefined, 3000, { tier: 3, ...FRESH })).toBe(
      "http://localhost:3000",
    );
    expect(await resolveAppUrl(undefined, 8080, { tier: 3, ...FRESH })).toBe(
      "http://localhost:8080",
    );
  });

  it("elides the port when the platform binds :80 (matches appUrlForPort)", async () => {
    expect(await resolveAppUrl(undefined, 80, { tier: 3, ...FRESH })).toBe("http://localhost");
  });

  it("honors the --app-url flag on a fresh install (normalized)", async () => {
    expect(await resolveAppUrl("https://appstrate.example.com/", 3000, { tier: 3, ...FRESH })).toBe(
      "https://appstrate.example.com",
    );
  });

  it("honors APPSTRATE_APP_URL (curl|bash path), flag wins over env", async () => {
    process.env.APPSTRATE_APP_URL = "https://env.example.com";
    expect(await resolveAppUrl(undefined, 3000, { tier: 3, ...FRESH })).toBe(
      "https://env.example.com",
    );
    expect(await resolveAppUrl("https://flag.example.com", 3000, { tier: 3, ...FRESH })).toBe(
      "https://flag.example.com",
    );
  });

  it("an empty APPSTRATE_APP_URL is treated as unset", async () => {
    process.env.APPSTRATE_APP_URL = "   ";
    expect(await resolveAppUrl(undefined, 3000, { tier: 3, ...FRESH })).toBe(
      "http://localhost:3000",
    );
  });

  it("applies the flag on Tier 0 too (no prompt, but scripted override works)", async () => {
    expect(await resolveAppUrl("https://appstrate.example.com", 3000, { tier: 0, ...FRESH })).toBe(
      "https://appstrate.example.com",
    );
  });

  it("throws on an invalid --app-url (fail-fast at install time)", async () => {
    await expect(resolveAppUrl("not a url", 3000, { tier: 3, ...FRESH })).rejects.toThrow(
      /Expected an absolute URL/,
    );
    await expect(
      resolveAppUrl("https://example.com/sub/path", 3000, { tier: 3, ...FRESH }),
    ).rejects.toThrow(/origin only/);
  });

  it("upgrade inherits the existing APP_URL from .env (mergeEnv — existing wins)", async () => {
    const existing = {
      hasEnv: true,
      hasCompose: true,
      existingEnv: { APP_URL: "https://old.example.com" },
    };
    expect(
      await resolveAppUrl(undefined, 3000, {
        tier: 3,
        mode: "upgrade",
        existing,
        nonInteractive: true,
      }),
    ).toBe("https://old.example.com");
    // A divergent flag is warned about + ignored — same contract as --port.
    expect(
      await resolveAppUrl("https://new.example.com", 3000, {
        tier: 3,
        mode: "upgrade",
        existing,
        nonInteractive: true,
      }),
    ).toBe("https://old.example.com");
  });

  it("upgrade without APP_URL in the existing .env falls through to flag/default", async () => {
    const existing = { hasEnv: true, hasCompose: true, existingEnv: {} };
    expect(
      await resolveAppUrl("https://new.example.com", 3000, {
        tier: 3,
        mode: "upgrade",
        existing,
        nonInteractive: true,
      }),
    ).toBe("https://new.example.com");
    expect(
      await resolveAppUrl(undefined, 3000, {
        tier: 3,
        mode: "upgrade",
        existing,
        nonInteractive: true,
      }),
    ).toBe("http://localhost:3000");
  });
});

describe("assertLoopbackPortMatches (issue #822) — loopback port-mismatch guard", () => {
  it("throws when a plain-http localhost URL disagrees with the bind port", () => {
    expect(() => assertLoopbackPortMatches("http://localhost:1234", 3000)).toThrow(
      /doesn't match the platform bind port 3000/,
    );
    expect(() => assertLoopbackPortMatches("http://127.0.0.1:1234", 3000)).toThrow(/--port 1234/);
    // Portless http://localhost means :80.
    expect(() => assertLoopbackPortMatches("http://localhost", 3000)).toThrow(/--port 80/);
  });

  it("passes when the ports agree", () => {
    expect(() => assertLoopbackPortMatches("http://localhost:8080", 8080)).not.toThrow();
    expect(() => assertLoopbackPortMatches("http://localhost", 80)).not.toThrow();
    expect(() => assertLoopbackPortMatches("http://[::1]:3000", 3000)).not.toThrow();
  });

  it("skips https loopback (local TLS-terminating proxy is legitimate)", () => {
    expect(() => assertLoopbackPortMatches("https://localhost:8443", 3000)).not.toThrow();
  });

  it("skips remote URLs — the proxy bridges public port and bind port", () => {
    expect(() => assertLoopbackPortMatches("http://example.com", 3000)).not.toThrow();
    expect(() => assertLoopbackPortMatches("https://example.com", 3000)).not.toThrow();
  });

  it("is enforced by resolveAppUrl on the flag path", async () => {
    await expect(
      resolveAppUrl("http://localhost:1234", 3000, {
        tier: 3,
        mode: "fresh",
        existing: NO_EXISTING,
        nonInteractive: true,
      }),
    ).rejects.toThrow(/doesn't match the platform bind port/);
    // Matching port stays accepted (equivalent to the derived default).
    await expect(
      resolveAppUrl("http://localhost:1234", 1234, {
        tier: 3,
        mode: "fresh",
        existing: NO_EXISTING,
        nonInteractive: true,
      }),
    ).resolves.toBe("http://localhost:1234");
  });
});

describe("reconcileUpgradeTier", () => {
  it("inherits the installed tier when the default would silently change the stack", () => {
    // The #829 hazard: `install --yes` (default Tier 2) re-run on a Tier 3
    // deployment must NOT rewrite compose with the Tier 2 template — MinIO
    // would vanish while .env keeps the S3 config, hiding all stored objects.
    const r = reconcileUpgradeTier(2, undefined, 3);
    expect(r.tier).toBe(3);
    expect(r.note).toMatch(/keeping Tier 3/i);
    expect(r.note).toMatch(/--tier 2/);
  });

  it("inherits downward too (pre-existing reverse hazard: Tier 2 install, Tier 3 pick)", () => {
    const r = reconcileUpgradeTier(3, undefined, 2);
    expect(r.tier).toBe(2);
    expect(r.note).toMatch(/keeping Tier 2/i);
  });

  it("an explicit --tier always wins (scripted tier changes stay possible)", () => {
    const r = reconcileUpgradeTier(2, "2", 3);
    expect(r.tier).toBe(2);
    expect(r.note).toBeUndefined();
  });

  it("keeps the resolved tier when no compose tier could be inferred", () => {
    const r = reconcileUpgradeTier(2, undefined, null);
    expect(r.tier).toBe(2);
    expect(r.note).toBeUndefined();
  });

  it("keeps a Tier 0 resolution untouched (source-clone dirs have no compose tier)", () => {
    const r = reconcileUpgradeTier(0, undefined, 3);
    expect(r.tier).toBe(0);
    expect(r.note).toBeUndefined();
  });

  it("is a no-op when the tiers already agree", () => {
    const r = reconcileUpgradeTier(3, undefined, 3);
    expect(r.tier).toBe(3);
    expect(r.note).toBeUndefined();
  });

  it("inherits an installed Tier 0 (a --yes re-run must not convert PGlite installs to Docker)", () => {
    // Tier 0 dirs (`.env` without POSTGRES_PASSWORD/DATABASE_URL, no compose)
    // hold their data in PGlite + ./data — resolving the Docker-aware default
    // (Tier 2) on top would boot an empty Postgres and hide every user/org.
    const r = reconcileUpgradeTier(2, undefined, 0);
    expect(r.tier).toBe(0);
    expect(r.note).toMatch(/keeping Tier 0/i);
    expect(r.note).toMatch(/--tier 2/);
  });

  it("an explicit --tier still converts a Tier 0 install (operator owns the migration)", () => {
    const r = reconcileUpgradeTier(2, "2", 0);
    expect(r.tier).toBe(2);
    expect(r.note).toBeUndefined();
  });
});
