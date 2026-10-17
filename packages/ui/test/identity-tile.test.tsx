// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { derivedColor } from "@appstrate/core/appearance";
import { IdentityTile } from "../src/components/identity-tile.tsx";
import { IDENTITY_COLOR_CLASSES } from "../src/identity-colors.ts";

const SEED = "spc_0123456789";
// The form of an uploaded icon; only the `data:image/` prefix matters to the tile.
const IMAGE = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function render(props: Parameters<typeof IdentityTile>[0]): string {
  return renderToStaticMarkup(<IdentityTile {...props} />);
}

describe("IdentityTile", () => {
  it("draws the initials on the colour derived from the seed when none is chosen", () => {
    const html = render({ seed: SEED, label: "Équipe Produit", color: null });
    expect(html).toContain(">ÉP<");
    expect(html).toContain(IDENTITY_COLOR_CLASSES[derivedColor(SEED)]);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("rounded-lg");
  });

  it("draws a chosen colour, and derives one from an unreadable value", () => {
    expect(render({ seed: SEED, label: "A", color: "violet" })).toContain(
      "bg-identity-violet/20 text-identity-violet",
    );
    expect(render({ seed: SEED, label: "A", color: "#ff0000" })).toContain(
      IDENTITY_COLOR_CLASSES[derivedColor(SEED)],
    );
  });

  it("draws neutral on the muted surface", () => {
    const html = render({ seed: SEED, label: "A", color: "neutral" });
    expect(html).toContain("bg-muted text-muted-foreground");
    expect(html).not.toContain("bg-identity-");
  });

  it("draws a Lucide icon instead of the initials", () => {
    // `DynamicIcon` loads the SVG after mount, so the static markup holds the tile alone.
    const html = render({ seed: SEED, label: "Mail Bot", icon: "lucide:mail", color: "blue" });
    expect(html).not.toContain("MB");
    expect(html).toContain("text-identity-blue");
  });

  it("draws an emoji scaled to the tile", () => {
    const html = render({ seed: SEED, label: "Ferme", icon: "emoji:🚜" });
    expect(html).toContain("🚜");
    expect(html).toContain("text-[length:55cqw]");
    expect(html).not.toContain(">F<");
  });

  it("keeps the initials as the fallback of an image until it has loaded", () => {
    // Radix draws `AvatarImage` once the browser reports it loaded, never in static markup.
    const html = render({ seed: SEED, label: "Acme Corp", icon: IMAGE, shape: "round" });
    expect(html).toContain(">AC<");
    expect(html).not.toContain("<img");
    expect(html).toContain("rounded-full");
  });

  it("draws the fallback icon for an absent or unreadable icon", () => {
    for (const icon of [null, "icon.png", "emoji:not-an-emoji"]) {
      const html = render({ seed: SEED, label: "Mon agent", icon, fallbackIcon: "emoji:🤖" });
      expect(html).toContain("🤖");
      expect(html).not.toContain(">MA<");
    }
  });

  it("is sized by the caller", () => {
    expect(render({ seed: SEED, label: "A", className: "size-7" })).toContain("size-7");
    expect(render({ seed: SEED, label: "A", className: "size-7" })).not.toContain("h-10 w-10");
  });
});
