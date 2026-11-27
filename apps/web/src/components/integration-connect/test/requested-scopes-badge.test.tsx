// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { installSpaStorage } from "../../../test/fake-storage.ts";

installSpaStorage();

const { render } = await import("../../../test/render.tsx");
const { ConnectionRequestedScopesBadge } = await import("../connection-status-badge.tsx");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

describe("ConnectionRequestedScopesBadge", () => {
  it("names the scopes a server asked for", () => {
    const html = render(<ConnectionRequestedScopesBadge scopes={["mail.send", "mail.read"]} />);
    expect(html).toContain("Droits supplémentaires demandés : mail.send, mail.read");
  });

  it("renders nothing without a demand", () => {
    expect(render(<ConnectionRequestedScopesBadge scopes={[]} />)).toBe("");
  });
});
