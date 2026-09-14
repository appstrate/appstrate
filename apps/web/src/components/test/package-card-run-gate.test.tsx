// SPDX-License-Identifier: Apache-2.0

/**
 * The launch control on an agent card, against the two facts the index page
 * carries per row.
 *
 * `GET /api/agents` lists what the space READS — homed here, offered here, or
 * system — while a run needs an installation in that space on top
 * (`AgentListItem.installed`). The card is where a reader meets both: it must
 * say which of the two is missing instead of letting the click come back a 404.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PackageCard } = await import("../package-card.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const i18n = i18nModule.default;
const ORG_ID = "org_a";

/** Render one agent card for a caller who holds `agents:run`. */
function cardFor(installed: boolean): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions: ["agents:run"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(
      <PackageCard
        id="@acme/worker"
        displayName="Worker"
        type="agent"
        source="local"
        installed={installed}
      />,
      { queryClient },
    );
  } finally {
    snapshot.mockRestore();
  }
}

/**
 * The card's only `<button>` is the launcher. Returned as its open tag, where
 * the `disabled` ATTRIBUTE is read — the Tailwind class list carries
 * `disabled:opacity-50` on every render, so a substring test would always pass.
 */
function launchButton(html: string): { tag: string; disabled: boolean } {
  const tag = /<button\b[^>]*>/.exec(html)?.[0];
  expect(tag).toBeDefined();
  return { tag: tag!, disabled: / disabled=""/.test(tag!) };
}

describe("an agent readable here but installed nowhere", () => {
  it("greys the launcher out and names the missing installation", () => {
    const button = launchButton(cardFor(false));
    expect(button.disabled).toBe(true);
    expect(button.tag).toContain(i18n.t("detail.titleNotInstalled", { ns: "agents" }));
  });
});

describe("an agent installed here", () => {
  it("CONTROL: leaves the launcher live, so `installed` is the gate", () => {
    const button = launchButton(cardFor(true));
    expect(button.disabled).toBe(false);
    expect(button.tag).toContain(i18n.t("detail.run", { ns: "agents" }));
  });
});
