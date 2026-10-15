// SPDX-License-Identifier: Apache-2.0

/**
 * An integration's Paramètres (its `#configuration` tab): the address of each
 * section, and which navigations leave the definition editor its Définition
 * sections share.
 */

import { describe, expect, it } from "bun:test";
import { leavesEditor } from "../editor-place.ts";
import { integrationSettingsHref, settingsEditorPlace } from "../settings-section-href.ts";

const INTEGRATION = "/integrations/@acme/gmail";
const url = (path: string) => new URL(path, "https://app.test");

/** The rail ids the integration definition editor serves. */
const DEFINITION_SECTIONS = ["identity", "source", "auth-methods", "tools"];

const place = (search: URLSearchParams) =>
  settingsEditorPlace(
    search.get("integrationSettings") ?? "authentication",
    search,
    DEFINITION_SECTIONS,
  );
const leaves = (from: string, to: string) => leavesEditor(url(from), url(to), place);

describe("integrationSettingsHref", () => {
  it("names the section under the configuration tab, and nothing from the page left", () => {
    expect(integrationSettingsHref(INTEGRATION, "access")).toBe(
      `${INTEGRATION}?integrationSettings=access#configuration`,
    );
    expect(integrationSettingsHref(INTEGRATION, "files", { file: "manifest.json" })).toBe(
      `${INTEGRATION}?integrationSettings=files&file=manifest.json#configuration`,
    );
  });
});

describe("leavesEditor on an integration's Paramètres", () => {
  const identity = integrationSettingsHref(INTEGRATION, "identity");

  it("lets the definition editor move between its own sections", () => {
    expect(leaves(identity, integrationSettingsHref(INTEGRATION, "auth-methods"))).toBe(false);
    expect(leaves(identity, integrationSettingsHref(INTEGRATION, "tools"))).toBe(false);
  });

  it("stops a switch to a section another view renders", () => {
    expect(leaves(identity, integrationSettingsHref(INTEGRATION, "authentication"))).toBe(true);
    expect(leaves(identity, integrationSettingsHref(INTEGRATION, "functioning"))).toBe(true);
    expect(leaves(identity, `${INTEGRATION}#connections`)).toBe(true);
  });

  it("lets the raw manifest open over Identité", () => {
    expect(
      leaves(identity, integrationSettingsHref(INTEGRATION, "identity", { editManifest: "1" })),
    ).toBe(false);
  });
});
