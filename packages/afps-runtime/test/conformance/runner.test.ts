// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  BUILT_IN_CASES,
  createDefaultAdapter,
  formatReport,
  runConformance,
  type ConformanceAdapter,
  type ConformanceCase,
} from "../../src/conformance/index.ts";

describe("runConformance — default adapter", () => {
  it("passes every built-in case", async () => {
    const adapter = createDefaultAdapter();
    const report = await runConformance(adapter);
    expect(report.summary.total).toBe(BUILT_IN_CASES.length);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBe(BUILT_IN_CASES.length);
    expect(report.adapter).toBe("@appstrate/afps-runtime");
  });

  it("includes all three levels by default", async () => {
    const report = await runConformance(createDefaultAdapter());
    expect(report.levels).toEqual(["L1", "L2", "L3"]);
  });

  it("reports per-case durations as non-negative numbers", async () => {
    const report = await runConformance(createDefaultAdapter());
    for (const c of report.cases) {
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("restricts execution when --levels is set", async () => {
    const report = await runConformance(createDefaultAdapter(), { levels: ["L1"] });
    expect(report.summary.failed).toBe(0);
    expect(new Set(report.cases.map((c) => c.level))).toEqual(new Set(["L1"]));
  });

  it("restricts execution when --only is set (takes precedence over levels)", async () => {
    const report = await runConformance(createDefaultAdapter(), {
      levels: ["L1", "L2", "L3"],
      only: ["L1.1", "L3.4"],
    });
    expect(report.cases.map((c) => c.id).sort()).toEqual(["L1.1", "L3.4"]);
  });

  it("returns an empty report when --only matches no case", async () => {
    const report = await runConformance(createDefaultAdapter(), { only: ["NOPE.0"] });
    expect(report.summary.total).toBe(0);
    expect(report.cases).toHaveLength(0);
  });
});

describe("runConformance — failure handling", () => {
  function brokenAdapter(overrides: Partial<ConformanceAdapter> = {}): ConformanceAdapter {
    const base = createDefaultAdapter();
    return { ...base, ...overrides, name: "broken-adapter" };
  }

  it("records an adapter failure without short-circuiting other cases", async () => {
    const adapter = brokenAdapter({
      loadBundle: () => {
        throw new Error("boom");
      },
    });
    const report = await runConformance(adapter, { levels: ["L1"] });
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(report.cases.length).toBe(BUILT_IN_CASES.filter((c) => c.level === "L1").length);
    // L1.2 (rejects non-ZIP) expects throws — broken loadBundle throws too, so it "passes".
    // The positive cases (L1.1, L1.5) however should fail.
    expect(report.cases.find((c) => c.id === "L1.1")?.status).toBe("fail");
    expect(report.cases.find((c) => c.id === "L1.5")?.status).toBe("fail");
  });

  it("marks an individual case as fail when its run() throws", async () => {
    const extraCase: ConformanceCase = {
      id: "X.1",
      level: "L1",
      title: "explodes on purpose",
      run: () => {
        throw new Error("kaboom");
      },
    };
    const report = await runConformance(createDefaultAdapter(), {
      only: ["X.1"],
      extraCases: [extraCase],
    });
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.status).toBe("fail");
    expect(report.cases[0]!.detail).toContain("threw");
    expect(report.cases[0]!.detail).toContain("kaboom");
  });

  it("captures a CaseResult fail with its detail", async () => {
    const extraCase: ConformanceCase = {
      id: "X.2",
      level: "L2",
      title: "explicit fail",
      run: () => ({ status: "fail", detail: "something specific" }),
    };
    const report = await runConformance(createDefaultAdapter(), {
      only: ["X.2"],
      extraCases: [extraCase],
    });
    expect(report.cases[0]!.status).toBe("fail");
    expect(report.cases[0]!.detail).toBe("something specific");
  });
});

describe("formatReport", () => {
  it("renders a deterministic human-readable block", async () => {
    const report = await runConformance(createDefaultAdapter(), {
      only: ["L1.1", "L2.1"],
    });
    const text = formatReport(report);
    expect(text).toContain("Conformance report — @appstrate/afps-runtime");
    expect(text).toContain("✓ [L1.1]");
    expect(text).toContain("✓ [L2.1]");
    expect(text).toContain("Summary: 2/2 passed, 0 failed");
  });

  it("emits an indented detail line under failing cases", async () => {
    const failing: ConformanceCase = {
      id: "F.1",
      level: "L1",
      title: "forced fail",
      run: () => ({ status: "fail", detail: "because I said so" }),
    };
    const report = await runConformance(createDefaultAdapter(), {
      only: ["F.1"],
      extraCases: [failing],
    });
    const text = formatReport(report);
    expect(text).toContain("✗ [F.1]");
    expect(text).toContain("└─ because I said so");
  });
});
