// SPDX-License-Identifier: Apache-2.0

/**
 * The duration column, live and frozen.
 *
 * The live figure is a LEAF (`ElapsedDuration`). It used to be a `setInterval`
 * inside the run row itself, which re-rendered the whole row — badges, trigger,
 * links, popover — ten times a second for every running run on screen. The
 * structural assertion below is what keeps it a leaf.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ElapsedDuration, RunDuration } from "../run-duration.tsx";
import { render } from "./run-fixture.tsx";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../run-duration.tsx", import.meta.url)),
  "utf-8",
);

describe("ElapsedDuration", () => {
  it("renders the time elapsed since the run started", () => {
    const startedAt = new Date(Date.now() - 2_500).toISOString();
    const html = render(<ElapsedDuration startedAt={startedAt} />);
    // ~2.5s, allowing for the render taking a few milliseconds.
    expect(html).toMatch(/>2\.[45]s</);
  });
});

describe("RunDuration", () => {
  it("is the live figure while the run is going, never the stale one", () => {
    const startedAt = new Date(Date.now() - 3_000).toISOString();
    const html = render(<RunDuration status="running" startedAt={startedAt} duration={4200} />);
    expect(html).not.toContain("4.2s");
    expect(html).toMatch(/>[23]\.\ds</);
  });

  it("is the frozen figure once the run is over", () => {
    const html = render(<RunDuration status="success" startedAt={null} duration={4200} />);
    expect(html).toContain("4.2s");
  });

  it("renders nothing rather than a zero when the run was never measured", () => {
    expect(render(<RunDuration status="pending" startedAt={null} duration={null} />)).toBe("");
  });

  it("keeps the ticking state in the leaf — the column itself owns no timer", () => {
    const leafStart = SOURCE.indexOf("export function ElapsedDuration");
    const columnStart = SOURCE.indexOf("export function RunDuration(");
    expect(leafStart).toBeGreaterThan(-1);
    expect(columnStart).toBeGreaterThan(leafStart);

    // Exactly one timer in the file, and it sits inside the leaf.
    const intervals = [...SOURCE.matchAll(/setInterval\(/g)].map((m) => m.index);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toBeGreaterThan(leafStart);
    expect(intervals[0]).toBeLessThan(columnStart);

    // And nothing downstream of the leaf holds ticking state of its own.
    expect(SOURCE.slice(columnStart)).not.toContain("useState");
    expect(SOURCE.slice(columnStart)).not.toContain("useEffect");
  });
});
