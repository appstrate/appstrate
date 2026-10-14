// SPDX-License-Identifier: Apache-2.0

/**
 * While a save is in flight the form takes no input, embedded or not: a
 * keystroke made then would land after the state the save sends.
 */

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { EditorShell } from "../editor-shell.tsx";

await i18nReady;

function shell(isPending: boolean) {
  return render(
    <EditorShell
      type="agent"
      packageId="@acme/worker"
      isEdit
      displayName="Worker"
      tabs={[{ id: "general", label: "Général" }]}
      activeTab="general"
      onTabChange={() => {}}
      error={null}
      isPending={isPending}
      onSubmit={() => {}}
      onCancel={() => {}}
      presentation="embedded"
      isDirty
    >
      <input name="description" />
    </EditorShell>,
  );
}

describe("EditorShell embedded", () => {
  it("makes the form inert while saving", () => {
    expect(shell(true)).toMatch(/<div[^>]*inert=""[^>]*aria-busy="true"[^>]*><input/);
  });

  it("CONTROL: leaves it editable otherwise", () => {
    expect(shell(false)).not.toContain("inert");
  });
});
