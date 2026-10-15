// SPDX-License-Identifier: Apache-2.0

/**
 * While a save is in flight the form takes no input: a
 * keystroke made then would land after the state the save sends.
 */

import { afterAll, describe, expect, it } from "bun:test";
import type { PackageEditor } from "../package-editor/use-package-editor.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

// The frame's JSON editor loads the theme store, which reads the system theme
// and tags the root element at module init; the auth client reads the origin.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});
// Loaded before the stub: it injects its stylesheet when it sees a document.
await import("sonner");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { documentElement: { classList: { add: () => {}, remove: () => {} } } },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { i18nReady } = await import("../../i18n.ts");
const { render } = await import("../../test/render.tsx");
const { PackageEditorFrame } = await import("../package-editor/package-editor-frame.tsx");

await i18nReady;

function frame(isPending: boolean) {
  // Only what the editing frame reads; the rest of the editor is the hook's.
  const editor = {
    type: "agent",
    packageId: "@scope/agent",
    isEdit: true,
    state: { manifest: {} },
    activeTab: "general",
    error: null,
    isPending,
    isDirty: true,
    blocker: { state: "unblocked" },
  } as unknown as PackageEditor;
  return render(
    <PackageEditorFrame editor={editor} tabs={[{ id: "general", label: "Général" }]}>
      <input name="description" />
    </PackageEditorFrame>,
  );
}

describe("PackageEditorFrame editing", () => {
  it("makes the form inert while saving", () => {
    expect(frame(true)).toMatch(/<div[^>]*inert=""[^>]*aria-busy="true"[^>]*><input/);
  });

  it("CONTROL: leaves it editable otherwise", () => {
    expect(frame(false)).not.toContain("inert");
  });
});
