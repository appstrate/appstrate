// SPDX-License-Identifier: Apache-2.0

/**
 * The journal's two empty bodies: a run that logged nothing says so plainly,
 * and only a journal whose filters hide every event offers to clear them.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { ExecutionEntry } from "../log-utils.ts";

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

const message: ExecutionEntry = {
  id: "log_1",
  kind: "agent",
  level: "debug",
  message: "Je lis la boîte de réception.",
  createdAt: "2026-07-01T10:00:00.000Z",
};

describe("LogViewer — an empty journal", () => {
  it("says a run with no events has none, without offering to clear filters", () => {
    const html = render(<LogViewer entries={[]} onSelectEntry={() => {}} />);
    expect(html).toContain(agentsFr["log.empty"]);
    expect(html).not.toContain(agentsFr["log.noMatches"]);
    expect(html).not.toContain(commonFr["toolbar.clearAll"]);
  });

  it("says no event matches when the filters hide every one", () => {
    const html = render(
      <LogViewer entries={[message]} onSelectEntry={() => {}} initialFocus="errors" />,
    );
    expect(html).toContain(agentsFr["log.noMatches"]);
    expect(html).toContain(commonFr["toolbar.clearAll"]);
    expect(html).not.toContain(agentsFr["log.empty"]);
  });
});
