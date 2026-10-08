// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { render } from "@/test/render.tsx";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip.tsx";

describe("DisabledReasonTooltip", () => {
  it("puts the reason in the page, on a focusable wrapper — not only in a hover tooltip", () => {
    const html = render(
      <DisabledReasonTooltip reason="Verrouillé par un administrateur">
        <button disabled>Déconnecter</button>
      </DisabledReasonTooltip>,
    );
    // The closed tooltip renders nothing: this text is what a screen reader
    // reads on the wrapper, which a keyboard reaches where it skips the button.
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<span class="sr-only">Verrouillé par un administrateur</span>');
  });

  it("renders the control bare when there is nothing to explain", () => {
    expect(
      render(
        <DisabledReasonTooltip reason={null}>
          <button>Déconnecter</button>
        </DisabledReasonTooltip>,
      ),
    ).toBe("<button>Déconnecter</button>");
  });
});
