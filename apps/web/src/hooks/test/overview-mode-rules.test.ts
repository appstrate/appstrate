// SPDX-License-Identifier: Apache-2.0

/**
 * The steps « Tous les espaces » takes on its own: acting in a space the reader picked, and
 * withdrawing the mode on a page of one space or once the listing no longer offers it. Asserted on
 * the functions the hooks' callbacks and effects call: this harness renders with
 * `renderToStaticMarkup`, which never runs an effect nor a click.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

// The space and overview stores read `localStorage` at module init.
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { actInSpace } = await import("../use-space-action.tsx");
const { withdrawOnPage } = await import("../use-overview-mode.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");

describe("actInSpace", () => {
  beforeEach(() => spaceStore.getState().setId("spc_working"));

  it("enters the space picked as the working space, then acts in it", () => {
    const switched: string[] = [];
    const actedIn: (string | null)[] = [];
    actInSpace(
      "spc_picked",
      () => actedIn.push(spaceStore.getState().id),
      (spaceId) => {
        switched.push(spaceId);
        spaceStore.getState().setId(spaceId);
      },
    );
    expect(switched).toEqual(["spc_picked"]);
    // The action saw the space it was asked for: its requests are that space's.
    expect(actedIn).toEqual(["spc_picked"]);
  });

  it("acts at once in the working space, without switching", () => {
    const switched: string[] = [];
    let acted = 0;
    actInSpace(
      "spc_working",
      () => acted++,
      (spaceId) => switched.push(spaceId),
    );
    expect(acted).toBe(1);
    expect(switched).toEqual([]);
  });
});

describe("the overview rules", () => {
  const KEY = "usr_1:org_1";
  const chosen = () => !!overviewStore.getState().chosen[KEY];

  beforeEach(() => overviewStore.getState().set(KEY, true));

  it("keeps the mode on a list, one of its rows and a page of no space", () => {
    for (const pathname of [
      "/runs",
      "/agents/@acme/triage",
      "/",
      "/org-settings/members",
      "/chat",
      "/preferences/connections",
    ]) {
      withdrawOnPage(KEY, pathname);
      expect({ pathname, chosen: chosen() }).toEqual({ pathname, chosen: true });
    }
  });

  // The report « opening an agent's Paramètres › Connexions from the mode lands on « Mon espace » »:
  // the page holds the mode; the catalogue its « Voir dans le catalogue » opens withdrew it, and
  // closing the overlay left the reader in the space the row had silently entered.
  it("keeps the mode on an agent's settings and over the catalogue they link to", () => {
    for (const pathname of [
      "/agents/@acme/agent-form",
      "/catalogue/agent",
      "/catalogue/integration",
    ]) {
      withdrawOnPage(KEY, pathname);
      expect({ pathname, chosen: chosen() }).toEqual({ pathname, chosen: true });
    }
  });

  it("drops the mode on reaching a page of one space", () => {
    withdrawOnPage(KEY, "/integrations/new/mcp");
    expect(chosen()).toBe(false);
  });
});
