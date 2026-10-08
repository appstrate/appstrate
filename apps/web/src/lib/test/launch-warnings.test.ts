// SPDX-License-Identifier: Apache-2.0

/**
 * The one toast a launch (or a schedule write) makes of its `warnings[]`: the
 * integrations the run starts without, each named once, by display name — and
 * why, only as far as the items say it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { isViewersLaunch, launchWarningsToast, type LaunchWarning } from "../launch-warnings.ts";

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

const SHARED = {
  id: "c1",
  label: "Équipe",
  account_id: "team@acme.test",
  owned_by_actor: false,
  needs_reconnection: false,
};

describe("launchWarningsToast", () => {
  it("says nothing when the launch reports nothing", async () => {
    await i18n.changeLanguage("fr");
    expect(launchWarningsToast({ kind: "run", warnings: [], nameOf })).toBeNull();
    expect(launchWarningsToast({ kind: "run", warnings: undefined, nameOf })).toBeNull();
  });

  it("names one integration, by display name, in one toast", async () => {
    await i18n.changeLanguage("fr");
    expect(
      launchWarningsToast({
        kind: "run",
        warnings: [warning("@acme/gmail", { auth_key: "oauth" })],
        nameOf,
      }),
    ).toEqual({
      message: "Ce run s'exécute sans l'intégration Gmail",
      description: "Elle n'est pas connectée ; l'agent en est informé.",
      connectable: true,
    });
  });

  it("lists several integrations once each, in the server's order, falling back to the id", async () => {
    await i18n.changeLanguage("fr");
    const toast = launchWarningsToast({
      kind: "run",
      warnings: [
        warning("@acme/slack", { auth_key: "oauth" }),
        warning("@acme/gmail", { auth_key: "oauth" }),
        warning("@acme/slack", { candidate_connections: [] }),
        warning("@acme/notion", { required_auth_key: "api_key", available_auth_keys: ["oauth"] }),
      ],
      nameOf,
    });
    expect(toast?.message).toBe(
      "Ce run s'exécute sans les intégrations Slack, Gmail, @acme/notion",
    );
    expect(toast?.description).toBe("Elles ne sont pas connectées ; l'agent en est informé.");
  });

  it("speaks of the fires for a schedule", async () => {
    await i18n.changeLanguage("en");
    expect(
      launchWarningsToast({ kind: "schedule", warnings: [warning("@acme/gmail")], nameOf })
        ?.message,
    ).toBe("Scheduled runs will start without the Gmail integration");
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

describe("launchWarningsToast — why", () => {
  const describeOf = (warnings: LaunchWarning[]) =>
    launchWarningsToast({ kind: "run", warnings, nameOf });

  it("invites a pick when only other members' shared connections exist", async () => {
    await i18n.changeLanguage("fr");
    const toast = describeOf([warning("@acme/gmail", { candidate_connections: [SHARED] })]);
    expect(toast?.description).toBe(i18n.t("agents:launchWarnings.cause.sharedOnly", { count: 1 }));
    expect(toast?.connectable).toBe(true);
  });

  it("says an integration switched off in the space is disabled, with nothing to connect", async () => {
    await i18n.changeLanguage("fr");
    const toast = describeOf([warning("@acme/gmail", { code: "integration_not_active" })]);
    expect(toast?.description).toBe(
      "Elle est désactivée dans cet espace ; l'agent en est informé.",
    );
    expect(toast?.connectable).toBe(false);
  });

  it("never claims 'not connected' for an item naming no connect target — a chosen none", async () => {
    await i18n.changeLanguage("fr");
    const toast = describeOf([warning("@acme/gmail")]);
    expect(toast?.description).toBe("L'agent est informé qu'elle est indisponible.");
    expect(toast?.connectable).toBe(false);
  });

  it("falls back to the neutral sentence when the causes differ", async () => {
    await i18n.changeLanguage("fr");
    const toast = describeOf([
      warning("@acme/gmail", { auth_key: "oauth" }),
      warning("@acme/slack", { code: "integration_not_active" }),
    ]);
    expect(toast?.description).toBe("L'agent est informé qu'elles sont indisponibles.");
    // Control: one of them a connection would still bring back.
    expect(toast?.connectable).toBe(true);
  });
});

describe("isViewersLaunch", () => {
  it("a run is always the viewer's", () => {
    expect(isViewersLaunch({ kind: "run" }, "usr_me")).toBe(true);
  });

  it("a schedule is the viewer's only when it runs as them", () => {
    expect(isViewersLaunch({ kind: "schedule", userId: "usr_me" }, "usr_me")).toBe(true);
    expect(isViewersLaunch({ kind: "schedule", userId: "usr_bob" }, "usr_me")).toBe(false);
    // An end-user's schedule names no member.
    expect(isViewersLaunch({ kind: "schedule", userId: null }, "usr_me")).toBe(false);
    expect(isViewersLaunch({ kind: "schedule", userId: null }, undefined)).toBe(false);
  });
});
