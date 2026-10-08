// SPDX-License-Identifier: Apache-2.0

/**
 * The one toast a launch (or a schedule write) makes of its `warnings[]`: the
 * integrations the run starts without, each named once, by display name.
 */

import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { launchWarningsToast, type LaunchWarning } from "../launch-warnings.ts";

await i18nReady;
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

const warning = (id: string, over: Partial<LaunchWarning> = {}): LaunchWarning => ({
  field: `integrations.${id}`,
  code: "integration_unbound",
  message: "unbound",
  ...over,
});

const NAMES: Record<string, string> = { "@acme/gmail": "Gmail", "@acme/slack": "Slack" };
const nameOf = (id: string) => NAMES[id] ?? id;

describe("launchWarningsToast", () => {
  it("says nothing when the launch reports nothing", async () => {
    await i18n.changeLanguage("fr");
    expect(launchWarningsToast({ kind: "run", warnings: [], nameOf })).toBeNull();
    expect(launchWarningsToast({ kind: "run", warnings: undefined, nameOf })).toBeNull();
  });

  it("names one integration, by display name, in one toast", async () => {
    await i18n.changeLanguage("fr");
    expect(
      launchWarningsToast({ kind: "run", warnings: [warning("@acme/gmail")], nameOf }),
    ).toEqual({
      message: "Lancé sans l'intégration Gmail",
      description: "Elle n'est pas connectée : l'agent s'exécute sans elle et en est informé.",
    });
  });

  it("lists several integrations once each, in the server's order, falling back to the id", async () => {
    await i18n.changeLanguage("fr");
    const toast = launchWarningsToast({
      kind: "run",
      warnings: [
        warning("@acme/slack"),
        warning("@acme/gmail", { auth_key: "oauth" }),
        warning("@acme/slack", { candidate_connections: [] }),
        warning("@acme/notion"),
      ],
      nameOf,
    });
    expect(toast?.message).toBe("Lancé sans les intégrations Slack, Gmail, @acme/notion");
    expect(toast?.description).toBe(
      "Elles ne sont pas connectées : l'agent s'exécute sans elles et en est informé.",
    );
  });

  it("speaks of the fires for a schedule", async () => {
    await i18n.changeLanguage("en");
    expect(
      launchWarningsToast({ kind: "schedule", warnings: [warning("@acme/gmail")], nameOf })
        ?.message,
    ).toBe("Fires will run without the Gmail integration");
  });

  it("ignores an item about anything but an integration", async () => {
    await i18n.changeLanguage("fr");
    expect(
      launchWarningsToast({
        kind: "run",
        warnings: [warning("x", { field: "input.prompt" })],
        nameOf,
      }),
    ).toBeNull();
  });
});
