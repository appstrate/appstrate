// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  validateAgentIntegrationScopes,
  judgeToolApprovals,
  hiddenToolNames,
  type IntegrationManifest,
} from "../src/integration.ts";
import { integrationSpawnSpecSchema } from "../src/sidecar-types.ts";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

function manifest(opts: { declared?: string[]; open?: boolean }): IntegrationManifest {
  return {
    schema_version: "0.1",
    type: "integration",
    name: "@me/remote",
    version: "1.0.0",
    display_name: "Remote",
    source: { kind: "remote", url: "https://mcp.example.com/mcp" },
    ...(opts.declared
      ? { tools_policy: Object.fromEntries(opts.declared.map((n) => [n, {}])) }
      : {}),
    ...(opts.open ? { allow_undeclared_tools: true } : {}),
  } as unknown as IntegrationManifest;
}

/** Declares `d`, hides `h`; the catalog is open or closed as asked. */
const hiddenManifest = (open: boolean) =>
  ({ ...manifest({ declared: ["d"], open }), hidden_tools: ["h"] }) as IntegrationManifest;

describe("validateAgentIntegrationScopes — approved tools and empty catalogs", () => {
  const sel = (tools: string[]) => ({ id: "@me/remote", tools });
  it("approved names count as known on a closed catalog", () => {
    const m = manifest({ declared: ["d"] });
    expect(validateAgentIntegrationScopes(sel(["u"]), m)).toHaveLength(1);
    expect(validateAgentIntegrationScopes(sel(["u"]), m, { approvedTools: ["u"] })).toEqual([]);
  });
  it('an open catalog still accepts "*" and explicit names', () => {
    const m = manifest({ open: true });
    expect(validateAgentIntegrationScopes({ id: "@me/remote", tools: "*" }, m)).toEqual([]);
    expect(validateAgentIntegrationScopes(sel(["x"]), m)).toEqual([]);
  });
  it("an approved hidden name never validates", () => {
    const errors = validateAgentIntegrationScopes(sel(["h"]), hiddenManifest(false), {
      approvedTools: ["h"],
    });
    expect(errors.map((e) => e.code)).toEqual(["unknown_tool"]);
  });
  it("only local and none sources declaring no tools skip the name check (AFPS §7.1)", () => {
    for (const [source, refused] of [
      [{ kind: "local", server: { type: "binary", entry_point: "x" } }, false],
      [{ kind: "none" }, false],
      [{ kind: "remote", url: "https://mcp.example.com/mcp" }, true],
      [undefined, true],
    ] as const) {
      const m = { ...manifest({}), source } as unknown as IntegrationManifest;
      const codes = validateAgentIntegrationScopes(sel(["x"]), m).map((e) => e.code);
      expect({ kind: source?.kind, codes }).toEqual({
        kind: source?.kind,
        codes: refused ? ["unknown_tool"] : [],
      });
    }
  });
});

describe("integrationSpawnSpecSchema — approvedToolFingerprints and blockedTools", () => {
  const base = {
    integrationId: "@me/remote",
    namespace: "remote",
    sourceKind: "remote",
    manifest: { name: "@me/remote", version: "1.0.0" },
    spawnEnv: {},
  };
  const parse = (extra: object) => integrationSpawnSpecSchema.safeParse({ ...base, ...extra });
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`t${i}`, [FP_A]]));
  it("accepts a bounded map of sha-256 hex", () => {
    expect(parse({ approvedToolFingerprints: { t: [FP_A], u: [] } }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });
  it("rejects malformed or oversized values, naming the field", () => {
    expect(parse({ approvedToolFingerprints: { t: ["ABC"] } }).success).toBe(false);
    expect(parse({ approvedToolFingerprints: { t: ["A".repeat(64)] } }).success).toBe(false);
    expect(
      parse({ approvedToolFingerprints: { t: Array.from({ length: 33 }, () => FP_A) } }).success,
    ).toBe(false);
    const result = parse({ approvedToolFingerprints: many });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("approvedToolFingerprints");
  });
  it("accepts blockedTools names and refuses a non-array", () => {
    expect(parse({ blockedTools: ["a", "b"] }).success).toBe(true);
    expect(parse({ blockedTools: "a" }).success).toBe(false);
  });
});

describe("judgeToolApprovals", () => {
  const rows = [
    { tool_name: "d", fingerprint: FP_A, note: 1 },
    { tool_name: "h", fingerprint: FP_A, note: 2 },
    { tool_name: "u", fingerprint: FP_B, note: 3 },
  ];
  it("drops declared and hidden names on a closed catalog, keeps the row as given", () => {
    expect(judgeToolApprovals(hiddenManifest(false), rows)).toEqual(rows.slice(2));
  });
  it("drops every approval on an open catalog", () => {
    expect(judgeToolApprovals(hiddenManifest(true), rows)).toEqual([]);
  });
  it("an approval of a platform-hidden name never counts", () => {
    const m = manifest({});
    const connect = [...hiddenToolNames(m)];
    const judged = judgeToolApprovals(
      m,
      connect.map((tool_name) => ({ tool_name })),
    );
    expect(judged).toEqual([]);
  });
});
