// SPDX-License-Identifier: Apache-2.0

/** A run that logged nothing says so plainly, without offering to clear filters. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { LogViewer } = await import("../log-viewer.tsx");
const { render } = await import("../../test/render.tsx");
const agentsFr = (await import("../../locales/fr/agents.json")).default;
const commonFr = (await import("../../locales/fr/common.json")).default;
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

describe("LogViewer — an empty journal", () => {
  it("says a run with no events has none, without offering to clear filters", () => {
    const html = render(<LogViewer entries={[]} />);
    expect(html).toContain(agentsFr["log.empty"]);
    expect(html).not.toContain(agentsFr["log.noMatches"]);
    expect(html).not.toContain(commonFr["toolbar.clearAll"]);
  });
});
