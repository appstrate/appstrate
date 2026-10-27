// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "../src/components/switch.tsx";

describe("Switch", () => {
  it("starts its thumb at the track's edge, whatever the host's base button rule says", () => {
    // The app's base `button` rule centers its content; without an explicit start the
    // thumb sits 10px off in both states and overflows the track when checked.
    const html = renderToStaticMarkup(<Switch aria-label="x" />);
    expect(html).toContain("justify-start");
  });
});
