// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CONTRACT_VERSION,
  assertRenderedInvariants,
  compareContracts,
  contractKey,
  normalizeLandmarkLabel,
} from "./detail-contract-core.mjs";

/**
 * One rendered-contract entry. `style` is declared here even though the fixture
 * omits it: the drift test ADDS it to prove `compareContracts` flags a style it
 * did not expect, and an inferred literal type would refuse that assignment.
 */
interface ContractLandmark {
  key: string;
  kind: string;
  rect: { x: number; y: number; width: number; height: number };
  style?: string[];
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    screen: "agent-overview",
    path: "/agents/@tractr/compta-trimestrielle#overview",
    width: 1440,
    document: {
      viewportWidth: 1440,
      viewportOverflow: 0,
      mainOverflow: 0,
      clippedInteractiveCount: 0,
      localTablistCount: 1,
      activeLocalTabCount: 1,
    },
    landmarks: [
      { key: "main", kind: "main", rect: { x: 256, y: 0, width: 1184, height: 1000 } },
      { key: "panel", kind: "tabpanel", rect: { x: 299, y: 256, width: 1098, height: 341 } },
    ] as ContractLandmark[],
    ...overrides,
  };
}

describe("Agent/Run rendered contract", () => {
  it("normalizes volatile dates, versions and counts in landmark labels", () => {
    expect(normalizeLandmarkLabel("Run #131 · v1.4.0 · 28/08/2026 23:58")).toBe(
      "Run #<n> · <version> · <date>",
    );
    expect(normalizeLandmarkLabel("Dernier Runen cours28/08/2026 23:58")).toBe(
      "Dernier Runen cours<date>",
    );
  });

  it("allows a one-pixel geometry tolerance but rejects style drift", () => {
    const key = contractKey("agent-overview", 1440);
    const expected = { version: CONTRACT_VERSION, entries: { [key]: entry() } };
    const withinTolerance = {
      version: CONTRACT_VERSION,
      entries: {
        [key]: entry({
          landmarks: [
            { key: "main", kind: "main", rect: { x: 256.5, y: 0, width: 1183.5, height: 1000 } },
            { key: "panel", kind: "tabpanel", rect: { x: 299, y: 256, width: 1098, height: 341 } },
          ],
        }),
      },
    };
    expect(compareContracts(expected, withinTolerance)).toEqual([]);

    const drifted = structuredClone(withinTolerance);
    // The key and the first landmark are both built two lines above; the
    // non-null assertions say so rather than adding a branch the test would
    // never take.
    drifted.entries[key]!.landmarks[0]!.style = ["rgb(0, 0, 0)"];
    expect(compareContracts(expected, drifted)).toContain(
      `entries.${key}.landmarks[0].style: unexpected`,
    );
  });

  it("reports overflow, clipped controls and a broken local tab contract", () => {
    expect(
      assertRenderedInvariants(
        entry({
          document: {
            viewportWidth: 1440,
            viewportOverflow: 12,
            mainOverflow: 4,
            clippedInteractiveCount: 2,
            localTablistCount: 0,
            activeLocalTabCount: 0,
          },
          landmarks: [{ key: "main", kind: "main", rect: {} }],
        }),
      ),
    ).toHaveLength(6);
  });

  it("compares a focused run without requiring every unrelated baseline entry", () => {
    const key = contractKey("agent-overview", 1440);
    const expected = {
      version: CONTRACT_VERSION,
      entries: {
        [key]: entry(),
        [contractKey("run-overview-active", 1440)]: entry({ screen: "run-overview-active" }),
      },
    };
    const actual = { version: CONTRACT_VERSION, entries: { [key]: entry() } };
    expect(compareContracts(expected, actual)).toEqual([]);
  });
});
