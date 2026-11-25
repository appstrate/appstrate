// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  resolveEffectiveToolCatalog,
  validateAgentIntegrationScopes,
  type IntegrationManifest,
  type ToolSnapshotView,
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

function snap(
  tools: Record<string, { fp?: string; changed?: boolean }>,
  truncated = false,
): ToolSnapshotView {
  return {
    truncated,
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      fingerprint: t.fp ?? FP_A,
      changed_at: t.changed ? "2026-01-01T00:00:00Z" : null,
    })),
  };
}

const policy = (approvals: [string, string][] = [], blocks: string[] = []) => ({
  approvals: approvals.map(([tool_name, fingerprint]) => ({ tool_name, fingerprint })),
  blocks,
});

function one(
  m: IntegrationManifest,
  name: string,
  p: ReturnType<typeof policy> | null,
  snapshots: ToolSnapshotView[],
) {
  return resolveEffectiveToolCatalog({ integration: m, policy: p, snapshots }).find(
    (e) => e.name === name,
  )!;
}

describe("resolveEffectiveToolCatalog — declared tools", () => {
  const m = manifest({ declared: ["t"] });
  it("available when listed; modified mirrors changed_at", () => {
    expect(one(m, "t", null, [snap({ t: {} })])).toMatchObject({
      status: "available",
      origin: "declared",
      modified: false,
    });
    expect(one(m, "t", null, [snap({ t: { changed: true } })]).modified).toBe(true);
  });
  it("missing when a snapshot exists and lacks it", () => {
    expect(one(m, "t", null, [snap({ x: {} })]).status).toBe("missing");
  });
  it("available without any snapshot", () => {
    expect(one(m, "t", null, []).status).toBe("available");
  });
  it("never missing when any snapshot is truncated", () => {
    expect(one(m, "t", null, [snap({ x: {} }), snap({}, true)]).status).toBe("available");
  });
  it("missing only when every snapshot lacks it; present in one is enough", () => {
    expect(one(m, "t", null, [snap({ x: {} }), snap({ y: {} })]).status).toBe("missing");
    expect(one(m, "t", null, [snap({ x: {} }), snap({ t: { fp: FP_B } })]).status).toBe(
      "available",
    );
  });
  it("modified when any listing snapshot changed", () => {
    const e = one(m, "t", null, [
      snap({ t: { fp: FP_A } }),
      snap({ t: { fp: FP_B, changed: true } }),
    ]);
    expect(e.modified).toBe(true);
  });
  it("blocked wins", () => {
    expect(one(m, "t", policy([], ["t"]), [snap({ t: {} })]).status).toBe("blocked");
    expect(one(m, "t", policy([], ["t"]), [snap({})]).status).toBe("blocked");
  });
  it("an approval of a declared tool is ignored", () => {
    const entries = resolveEffectiveToolCatalog({
      integration: m,
      policy: policy([["t", FP_B]]),
      snapshots: [snap({ t: {} })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origin: "declared", status: "available" });
  });
});

describe("resolveEffectiveToolCatalog — undeclared tools on a closed catalog", () => {
  const m = manifest({ declared: ["d"] });
  it("listed and not approved: pending, origin listed", () => {
    expect(one(m, "u", policy(), [snap({ d: {}, u: {} })])).toMatchObject({
      status: "pending",
      origin: "listed",
      modified: false,
    });
  });
  it("approved with the live fingerprint: available", () => {
    expect(one(m, "u", policy([["u", FP_A]]), [snap({ u: {} })])).toMatchObject({
      status: "available",
      origin: "approved",
      modified: false,
    });
  });
  it("approved under another fingerprint only: pending, modified", () => {
    expect(one(m, "u", policy([["u", FP_B]]), [snap({ u: {} })])).toMatchObject({
      status: "pending",
      origin: "approved",
      modified: true,
    });
  });
  it("several approved fingerprints: any snapshot matching one is enough", () => {
    const p = policy([
      ["u", FP_B],
      ["u", FP_A],
    ]);
    expect(
      one(m, "u", p, [snap({ u: { fp: FP_B } }), snap({ u: { fp: "c".repeat(64) } })]).status,
    ).toBe("available");
    expect(
      one(m, "u", policy([["u", FP_B]]), [
        snap({ u: { fp: "c".repeat(64) } }),
        snap({ u: { fp: FP_B } }),
      ]).status,
    ).toBe("available");
  });
  it("approved but absent from every snapshot: missing; no snapshot: available", () => {
    expect(one(m, "u", policy([["u", FP_A]]), [snap({ d: {} })]).status).toBe("missing");
    expect(one(m, "u", policy([["u", FP_A]]), []).status).toBe("available");
    expect(one(m, "u", policy([["u", FP_A]]), [snap({ d: {} }, true)]).status).toBe("available");
  });
  it("approved tool: modified is a listed fingerprint nobody approved, not changed_at", () => {
    expect(one(m, "u", policy([["u", FP_A]]), [snap({ u: { changed: true } })]).modified).toBe(
      false,
    );
    expect(
      one(m, "u", policy([["u", FP_A]]), [snap({ u: {} }), snap({ u: { fp: FP_B } })]),
    ).toMatchObject({ status: "available", modified: true });
  });
  it("blocked wins over approval", () => {
    expect(one(m, "u", policy([["u", FP_A]], ["u"]), [snap({ u: {} })]).status).toBe("blocked");
  });
});

describe("resolveEffectiveToolCatalog — hidden tools", () => {
  const hiddenManifest = (open: boolean) =>
    ({ ...manifest({ declared: ["d"], open }), hidden_tools: ["h"] }) as IntegrationManifest;
  it("never listed nor approved, closed or open catalog", () => {
    for (const open of [false, true]) {
      const names = resolveEffectiveToolCatalog({
        integration: hiddenManifest(open),
        policy: policy([["h", FP_A]]),
        snapshots: [snap({ d: {}, h: {}, u: {} })],
      }).map((e) => e.name);
      expect(names).toEqual(["d", "u"]);
    }
  });
});

describe("resolveEffectiveToolCatalog — open catalog and ordering", () => {
  it("listed undeclared tools are available, origin listed", () => {
    expect(
      one(manifest({ declared: ["d"], open: true }), "u", null, [snap({ u: {} })]),
    ).toMatchObject({
      status: "available",
      origin: "listed",
    });
  });
  it("blocking applies on an open catalog", () => {
    expect(one(manifest({ open: true }), "u", policy([], ["u"]), [snap({ u: {} })]).status).toBe(
      "blocked",
    );
  });
  it("declared first in catalog order, then the rest by name", () => {
    const names = resolveEffectiveToolCatalog({
      integration: manifest({ declared: ["z", "a"] }),
      policy: policy([["m", FP_A]]),
      snapshots: [snap({ z: {}, a: {}, q: {}, b: {} })],
    }).map((e) => e.name);
    expect(names).toEqual(["z", "a", "b", "m", "q"]);
  });
});

describe("validateAgentIntegrationScopes — approved tools and empty catalogs", () => {
  const sel = (tools: string[]) => ({ id: "@me/remote", tools });
  it("approved names count as known on a closed catalog", () => {
    const m = manifest({ declared: ["d"] });
    expect(validateAgentIntegrationScopes(sel(["u"]), m)).toHaveLength(1);
    expect(validateAgentIntegrationScopes(sel(["u"]), m, { approvedTools: ["u"] })).toEqual([]);
  });
  it("a closed remote catalog declaring nothing refuses any explicit name", () => {
    const errors = validateAgentIntegrationScopes(sel(["x"]), manifest({}));
    expect(errors.map((e) => e.code)).toEqual(["unknown_tool"]);
  });
  it("a local source declaring no tools is not name-checked (AFPS §7.1)", () => {
    const local = {
      ...manifest({}),
      source: { kind: "local", server: { runtime: "node", entrypoint: "x.js" } },
    } as unknown as IntegrationManifest;
    expect(validateAgentIntegrationScopes(sel(["x"]), local)).toEqual([]);
  });
  it('an open catalog still accepts "*" and explicit names', () => {
    const m = manifest({ open: true });
    expect(validateAgentIntegrationScopes({ id: "@me/remote", tools: "*" }, m)).toEqual([]);
    expect(validateAgentIntegrationScopes(sel(["x"]), m)).toEqual([]);
  });
});

describe("integrationSpawnSpecSchema — approvedToolFingerprints", () => {
  const base = {
    integrationId: "@me/remote",
    namespace: "remote",
    sourceKind: "remote",
    manifest: { name: "@me/remote", version: "1.0.0" },
    spawnEnv: {},
  };
  const parse = (extra: object) => integrationSpawnSpecSchema.safeParse({ ...base, ...extra });
  it("accepts a bounded map of sha-256 hex", () => {
    expect(parse({ approvedToolFingerprints: { t: [FP_A], u: [] } }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });
  it("rejects malformed or oversized values", () => {
    expect(parse({ approvedToolFingerprints: { t: ["ABC"] } }).success).toBe(false);
    expect(parse({ approvedToolFingerprints: { t: ["A".repeat(64)] } }).success).toBe(false);
    expect(
      parse({ approvedToolFingerprints: { t: Array.from({ length: 33 }, () => FP_A) } }).success,
    ).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`t${i}`, [FP_A]]));
    expect(parse({ approvedToolFingerprints: many }).success).toBe(false);
  });
});
