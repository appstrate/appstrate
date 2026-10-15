// SPDX-License-Identifier: Apache-2.0

/** The duration column, live while the run is going and frozen once it is over. */

import { describe, it, expect } from "bun:test";
import { RunDuration } from "../run-duration.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("RunDuration", () => {
  it("is the time elapsed since the run started while it is going", () => {
    const startedAt = new Date(Date.now() - 2_500).toISOString();
    const html = render(<RunDuration status="running" startedAt={startedAt} duration={null} />);
    // ~2,5 s, allowing for the render taking a few milliseconds.
    expect(html).toMatch(/>2,[45]\u202fs</);
  });

  it("is the live figure while the run is going, never the stale one", () => {
    const startedAt = new Date(Date.now() - 3_000).toISOString();
    const html = render(<RunDuration status="running" startedAt={startedAt} duration={4200} />);
    expect(html).not.toContain("4,2\u202fs");
    expect(html).toMatch(/>[23],\d\u202fs</);
  });

  it("is the frozen figure once the run is over, never live time", () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const html = render(<RunDuration status="success" startedAt={startedAt} duration={4200} />);
    expect(html).toContain("4,2\u202fs");
    expect(html).not.toContain("1m");
  });

  it("renders nothing rather than a zero when the run was never measured", () => {
    expect(render(<RunDuration status="pending" startedAt={null} duration={null} />)).toBe("");
  });
});
