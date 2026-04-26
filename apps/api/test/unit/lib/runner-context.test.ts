// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveRunnerContext } from "../../../src/lib/runner-context.ts";
import { setRunnerResolver } from "../../../src/lib/runner-resolver.ts";

// Minimal fake for the parts of `Hono.Context` that `resolveRunnerContext`
// touches: `req.header(name)` and `get("authExtra")`. We avoid pulling in
// the full Hono runtime to keep this strictly a unit test.
function makeContext(opts: {
  headers?: Record<string, string>;
  authExtra?: Record<string, unknown>;
}): {
  req: { header: (name: string) => string | undefined };
  get: (key: string) => unknown;
} {
  const headers = opts.headers ?? {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => (key === "authExtra" ? opts.authExtra : undefined),
  };
}

beforeEach(() => {
  setRunnerResolver(null);
});
afterEach(() => {
  setRunnerResolver(null);
});

describe("resolveRunnerContext", () => {
  it("returns null/null when no header, no resolver, no auth extra", async () => {
    const ctx = makeContext({});

    const result = await resolveRunnerContext(ctx as any);
    expect(result).toEqual({ name: null, kind: null });
  });

  it("reads X-Appstrate-Runner-Name + X-Appstrate-Runner-Kind from headers", async () => {
    const ctx = makeContext({
      headers: {
        "X-Appstrate-Runner-Name": "acme/web @ run-42",
        "X-Appstrate-Runner-Kind": "github-action",
      },
    });

    const result = await resolveRunnerContext(ctx as any);
    expect(result).toEqual({ name: "acme/web @ run-42", kind: "github-action" });
  });

  it("trims whitespace and clamps long values", async () => {
    const longName = "a".repeat(500);
    const ctx = makeContext({
      headers: { "X-Appstrate-Runner-Name": `   ${longName}   ` },
    });

    const result = await resolveRunnerContext(ctx as any);
    expect(result.name?.length).toBe(120);
    expect(result.name).toMatch(/^a+$/);
  });

  it("treats empty/whitespace-only header as missing", async () => {
    const ctx = makeContext({ headers: { "X-Appstrate-Runner-Name": "   " } });

    const result = await resolveRunnerContext(ctx as any);
    expect(result.name).toBeNull();
  });

  it("falls back to the registered resolver when header is absent", async () => {
    setRunnerResolver(async ({ cliFamilyId }) => {
      if (cliFamilyId === "crf_known") return { name: "pierres-mbp", kind: "cli" };
      return null;
    });
    const ctx = makeContext({ authExtra: { cliFamilyId: "crf_known" } });

    const result = await resolveRunnerContext(ctx as any);
    expect(result).toEqual({ name: "pierres-mbp", kind: "cli" });
  });

  it("explicit name header wins over the resolver", async () => {
    setRunnerResolver(async () => ({ name: "from-resolver", kind: "cli" }));
    const ctx = makeContext({
      headers: { "X-Appstrate-Runner-Name": "from-header" },
      authExtra: { cliFamilyId: "crf_known" },
    });

    const result = await resolveRunnerContext(ctx as any);
    expect(result.name).toBe("from-header");
  });

  it("explicit kind header wins over resolver-suggested kind", async () => {
    setRunnerResolver(async () => ({ name: "device-x", kind: "cli" }));
    const ctx = makeContext({
      headers: { "X-Appstrate-Runner-Kind": "github-action" },
      authExtra: { cliFamilyId: "crf_known" },
    });

    const result = await resolveRunnerContext(ctx as any);
    expect(result.kind).toBe("github-action");
  });

  it("ignores resolver result when name is null and no header was set", async () => {
    setRunnerResolver(async () => ({ name: null, kind: "cli" }));
    const ctx = makeContext({ authExtra: { cliFamilyId: "crf_unknown" } });

    const result = await resolveRunnerContext(ctx as any);
    expect(result.name).toBeNull();
    // The resolver still gets to set the kind even when it can't supply
    // a name — the dashboard then renders the generic remote icon with
    // no label. Keeping the kind preserves whatever telemetry value it
    // carried before the device row was deleted/renamed.
    expect(result.kind).toBe("cli");
  });
});
