// SPDX-License-Identifier: Apache-2.0

/**
 * Which navigations the unsaved-changes guard stops on a detail page, where
 * the definition and file editors live under a tab (`#settings`) and a section
 * named in the query: switching tab or section unmounts the editor, opening a
 * modal over it does not.
 */

import { describe, expect, it } from "bun:test";
import { leavesEditor } from "../editor-place.ts";
import { agentSettingsHref, settingsEditorPlace } from "../settings-section-href.ts";

const AGENT = "/agents/@acme/worker";
const origin = "https://app.test";
const url = (path: string) => new URL(path, origin);

/** The agent view's resolution, for a reader who may configure the agent. */
const place = (search: URLSearchParams) =>
  settingsEditorPlace(search.get("agentSettings") ?? "model", search);

const leaves = (from: string, to: string) => leavesEditor(url(from), url(to), place);

describe("leavesEditor on an agent's Paramètres", () => {
  const definition = agentSettingsHref(AGENT, "schema");

  it("stops a tab switch, a section switch and a new page", () => {
    expect(leaves(definition, `${AGENT}#runs`)).toBe(true);
    expect(leaves(definition, `${AGENT}?agentSettings=schema`)).toBe(true);
    expect(leaves(definition, agentSettingsHref(AGENT, "model"))).toBe(true);
    expect(leaves(definition, "/agents")).toBe(true);
  });

  it("lets the definition editor move between its own sections", () => {
    expect(leaves(definition, agentSettingsHref(AGENT, "tools"))).toBe(false);
  });

  it("lets a modal open and close over the editor", () => {
    const withModal = agentSettingsHref(AGENT, "schema", { editManifest: "1" });
    expect(leaves(definition, withModal)).toBe(false);
    expect(leaves(withModal, definition)).toBe(false);

    const files = agentSettingsHref(AGENT, "files");
    expect(leaves(files, agentSettingsHref(AGENT, "files", { newFile: "1" }))).toBe(false);
  });

  it("stops a change of the file the explorer is keyed on", () => {
    expect(
      leaves(
        agentSettingsHref(AGENT, "files", { file: "prompt.md" }),
        agentSettingsHref(AGENT, "files", { file: "manifest.json" }),
      ),
    ).toBe(true);
  });

  it("reads a section named by default and by name as one", () => {
    expect(leaves(`${AGENT}#settings`, agentSettingsHref(AGENT, "model"))).toBe(false);
  });
});

describe("agentSettingsHref", () => {
  it("names the section, the default one included, and nothing from the page left", () => {
    expect(agentSettingsHref(AGENT, "model")).toBe(`${AGENT}?agentSettings=model#settings`);
    expect(agentSettingsHref(AGENT, "files", { file: "a b.md" })).toBe(
      `${AGENT}?agentSettings=files&file=a+b.md#settings`,
    );
  });
});
