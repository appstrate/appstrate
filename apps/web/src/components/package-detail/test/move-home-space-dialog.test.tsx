// SPDX-License-Identifier: Apache-2.0

/** The move dialog's schedule line: said only once known, and following the "keep" checkbox. */

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { PreviousHomeSchedules } from "../move-home-space-dialog.tsx";

await i18nReady;

describe("PreviousHomeSchedules", () => {
  it("says the schedules keep running, in the plural", () => {
    const html = render(<PreviousHomeSchedules state={2} keep space="Marketing" />);
    expect(html).toContain("2 planifications actives de « Marketing » continueront de tourner.");
  });

  it("says a single schedule will be disabled when the package is released", () => {
    const html = render(<PreviousHomeSchedules state={1} keep={false} space="Marketing" />);
    expect(html).toContain("1 planification active de « Marketing » sera désactivée.");
  });

  it("says none when there is no active schedule", () => {
    const html = render(<PreviousHomeSchedules state={0} keep space="Marketing" />);
    expect(html).toContain("Aucune planification active dans « Marketing ».");
  });

  it("falls back to a sentence without a count when unknown", () => {
    const kept = render(<PreviousHomeSchedules state="unknown" keep space="Marketing" />);
    expect(kept).toContain("Les planifications de « Marketing » continueront de tourner.");
    const released = render(
      <PreviousHomeSchedules state="unknown" keep={false} space="Marketing" />,
    );
    expect(released).toContain("seront désactivées.");
    expect(kept.replace(/<[^>]*>/g, "")).not.toMatch(/\d/);
  });

  it("renders nothing when not applicable", () => {
    expect(render(<PreviousHomeSchedules state={null} keep space="Marketing" />)).toBe("");
  });

  it("shows neither a count nor 'none' while loading", () => {
    const html = render(<PreviousHomeSchedules state="loading" keep space="Marketing" />);
    expect(html).not.toContain("Aucune");
    expect(html).not.toContain("planification");
  });
});
