// SPDX-License-Identifier: Apache-2.0

/**
 * `SIDECAR_MAX_REQUEST_BODY_BYTES` has exactly ONE parser.
 *
 * The sidecar's `MAX_REQUEST_BODY_SIZE` (`../helpers.ts`) and the resolvers'
 * `MAX_REQUEST_BODY_SIZE` (`@appstrate/afps-runtime/resolvers`) used to parse
 * that variable independently, with opposite failure policies: the sidecar
 * threw at boot on a malformed or over-ceiling override, the resolvers
 * silently returned the 10 MB default. Both module graphs load in the sidecar
 * process — `credential-proxy.ts` and `integrations-boot.ts` import the
 * resolvers for `executeApiCall` — so which policy an operator observed was
 * decided by import order. The resolvers now own the sole parse and the strict
 * policy; the sidecar re-exports their constant.
 *
 * Both constants are resolved at MODULE INIT from `process.env`, so a fresh
 * process per scenario is the only honest way to exercise them: mutating
 * `process.env` inside this test process would come too late, and `import()`
 * caches the evaluated module. Each case therefore spawns `bun -e` with the
 * override in its env and reads the outcome back.
 */

import { describe, it, expect } from "bun:test";

const SIDECAR_HELPERS = new URL("../helpers.ts", import.meta.url).pathname;
const RESOLVERS = new URL("../../../packages/afps-runtime/src/resolvers/index.ts", import.meta.url)
  .pathname;

interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run `script` in a fresh Bun process with `SIDECAR_MAX_REQUEST_BODY_BYTES` set. */
async function probe(script: string, override: string | undefined): Promise<ProbeResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.SIDECAR_MAX_REQUEST_BODY_BYTES;
  if (override !== undefined) env.SIDECAR_MAX_REQUEST_BODY_BYTES = override;
  const proc = Bun.spawn(["bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr };
}

/** Import BOTH graphs, as the sidecar process does, and report both caps. */
const BOTH_SCRIPT = `
const helpers = await import(${JSON.stringify(SIDECAR_HELPERS)});
const resolvers = await import(${JSON.stringify(RESOLVERS)});
console.log(JSON.stringify({
  sidecar: helpers.MAX_REQUEST_BODY_SIZE,
  resolver: resolvers.MAX_REQUEST_BODY_SIZE,
  ceiling: helpers.ABSOLUTE_BODY_CEILING,
  resolverCeiling: resolvers.ABSOLUTE_BODY_CEILING,
}));
`;

/** Import ONLY the resolvers — the graph that used to swallow bad overrides. */
const RESOLVER_ONLY_SCRIPT = `
const resolvers = await import(${JSON.stringify(RESOLVERS)});
console.log(JSON.stringify({ resolver: resolvers.MAX_REQUEST_BODY_SIZE }));
`;

/** Import ONLY the sidecar helpers — the graph that always refused. */
const SIDECAR_ONLY_SCRIPT = `
const helpers = await import(${JSON.stringify(SIDECAR_HELPERS)});
console.log(JSON.stringify({ sidecar: helpers.MAX_REQUEST_BODY_SIZE }));
`;

describe("SIDECAR_MAX_REQUEST_BODY_BYTES is parsed once", () => {
  it("both graphs report the compiled default when the override is unset", async () => {
    const { exitCode, stdout } = await probe(BOTH_SCRIPT, undefined);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.sidecar).toBe(10 * 1024 * 1024);
    expect(out.resolver).toBe(out.sidecar);
  });

  it("both graphs report the same value for a valid override", async () => {
    const { exitCode, stdout } = await probe(BOTH_SCRIPT, String(20 * 1024 * 1024));
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.sidecar).toBe(20 * 1024 * 1024);
    expect(out.resolver).toBe(out.sidecar);
  });

  it("both graphs share one 100 MB ceiling constant", async () => {
    const { exitCode, stdout } = await probe(BOTH_SCRIPT, undefined);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ceiling).toBe(100 * 1024 * 1024);
    expect(out.resolverCeiling).toBe(out.ceiling);
  });

  // --- The negative control: same refusal from BOTH graphs, in isolation. ---
  // Before the unification the resolver-only probes below exited 0 and printed
  // 10485760 while the sidecar-only probes exited non-zero.

  for (const override of ["abc", "0", "-1", "1.5"]) {
    it(`refuses the malformed override ${JSON.stringify(override)} from either graph alone`, async () => {
      const resolverOnly = await probe(RESOLVER_ONLY_SCRIPT, override);
      expect(resolverOnly.exitCode).not.toBe(0);
      expect(resolverOnly.stderr).toContain("must be a positive integer (bytes)");

      const sidecarOnly = await probe(SIDECAR_ONLY_SCRIPT, override);
      expect(sidecarOnly.exitCode).not.toBe(0);
      expect(sidecarOnly.stderr).toContain("must be a positive integer (bytes)");
    });
  }

  it("refuses an over-ceiling override from either graph alone", async () => {
    const over = String(200 * 1024 * 1024);

    const resolverOnly = await probe(RESOLVER_ONLY_SCRIPT, over);
    expect(resolverOnly.exitCode).not.toBe(0);
    expect(resolverOnly.stderr).toContain("exceeds the absolute ceiling of 104857600");

    const sidecarOnly = await probe(SIDECAR_ONLY_SCRIPT, over);
    expect(sidecarOnly.exitCode).not.toBe(0);
    expect(sidecarOnly.stderr).toContain("exceeds the absolute ceiling of 104857600");
  });

  it("refuses a bad override no matter which graph the process loads first", async () => {
    // Import order was the whole defect: the two policies could not both be
    // observed, so an operator got one or the other by accident.
    const resolverFirst = await probe(
      `
      await import(${JSON.stringify(RESOLVERS)});
      await import(${JSON.stringify(SIDECAR_HELPERS)});
      console.log("loaded");
      `,
      "abc",
    );
    expect(resolverFirst.exitCode).not.toBe(0);
    expect(resolverFirst.stdout).not.toContain("loaded");

    const sidecarFirst = await probe(
      `
      await import(${JSON.stringify(SIDECAR_HELPERS)});
      await import(${JSON.stringify(RESOLVERS)});
      console.log("loaded");
      `,
      "abc",
    );
    expect(sidecarFirst.exitCode).not.toBe(0);
    expect(sidecarFirst.stdout).not.toContain("loaded");
  });
});
