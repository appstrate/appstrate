// SPDX-License-Identifier: Apache-2.0

/**
 * `AgentInputForm` — the three launch-time display states, as rendered.
 *
 * The partition logic is unit-tested in `lib/test/agent-input.test.ts`; what
 * this file pins is what a user actually sees, because two of the three states
 * are only meaningful visually:
 *
 *   - a LOCKED field must be shown, with its resolved value, and must carry no
 *     editable control — "imposed" is a different statement from "hidden", and
 *     a different statement from "disabled";
 *   - a pre-filled field must be behind the collapsed "Avancé" fold, i.e. NOT
 *     in the markup until the user opens it.
 *
 * The web test runner has no DOM, so the component is rendered through the
 * shared `test/render.tsx` harness and asserted on its HTML — the same approach
 * as `run-row.test.tsx`. `<SchemaForm>` is lazy, so the two editable sections
 * render their Suspense fallback here; the assertions are on the section
 * boundaries this component owns, never on RJSF's internals.
 */

import { describe, it, expect } from "bun:test";
import type { SchemaWrapper } from "@appstrate/core/form";
import i18n, { i18nReady } from "../../i18n.ts";
import agentsFr from "../../locales/fr/agents.json";
import type { AgentInputSettings } from "../../lib/agent-input.ts";
import { render } from "../../test/render.tsx";
import { AgentInputForm } from "../agent-input-form.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const WRAPPER: SchemaWrapper = {
  schema: {
    type: "object",
    properties: {
      query: { type: "string", title: "Requête" },
      folder: { type: "string", title: "Dossier", default: "inbox" },
      tone: { type: "string", title: "Ton" },
    },
  },
};

function form(settings: AgentInputSettings, value: Record<string, unknown> = {}): string {
  return render(
    <AgentInputForm wrapper={WRAPPER} settings={settings} value={value} onChange={() => {}} />,
  );
}

describe("AgentInputForm display states", () => {
  it("prompts a field nothing decides yet, at the top level", () => {
    const html = form({ values: {}, locked_fields: [] });
    expect(html).toContain('data-testid="prompted-input-fields"');
  });

  it("folds a field that already has a value into the collapsed Avancé section", () => {
    const html = form({ values: {}, locked_fields: [] });
    // `folder` carries an author default → advanced, and the fold is CLOSED,
    // so its content must not be in the markup at all.
    expect(html).toContain('data-testid="advanced-input-toggle"');
    expect(html).toContain(agentsFr["input.advancedTitle"]);
    expect(html).toContain('aria-expanded="false"');
    // Radix leaves an empty hidden shell behind; the fields themselves are not
    // rendered until the user opens the fold.
    expect(html).not.toContain(agentsFr["input.advancedHint"]);
  });

  it("promotes a field to Avancé as soon as the editor stores a value for it", () => {
    // `tone` has no author default; a stored value alone must move it.
    const withoutStored = form({ values: {}, locked_fields: [] });
    const withStored = form({ values: { tone: "formel" }, locked_fields: [] });
    expect(withoutStored).toContain('data-testid="prompted-input-fields"');
    expect(withStored).toContain('data-testid="advanced-input-toggle"');
  });

  it("renders nothing for an agent that declares no parameters", () => {
    const html = render(
      <AgentInputForm
        wrapper={{ schema: { type: "object", properties: {} } }}
        settings={{ values: {}, locked_fields: [] }}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});

describe("AgentInputForm locked fields", () => {
  it("shows the locked field with its resolved value and no editable control", () => {
    const html = form({ values: { folder: "archive" }, locked_fields: ["folder"] });
    expect(html).toContain('data-testid="locked-input-folder"');
    expect(html).toContain("Dossier");
    // The stored value wins over the author default, exactly as at run time.
    expect(html).toContain("archive");
    expect(html).not.toContain("inbox");
    // A value display, not a disabled input: no form control is emitted for it.
    expect(html).not.toContain('name="folder"');
    expect(html).not.toContain("disabled");
  });

  it("names the constraint in words, not just with an icon", () => {
    const html = form({ values: { folder: "archive" }, locked_fields: ["folder"] });
    expect(html).toContain(agentsFr["input.lockedTitle"]);
    expect(html).toContain(agentsFr["input.lockedHint"]);
    expect(html).toContain(agentsFr["input.lockedBadge"]);
  });

  it("falls back to the author default when the editor stored no value", () => {
    const html = form({ values: {}, locked_fields: ["folder"] });
    expect(html).toContain("inbox");
  });

  it("shows the absence of a value rather than an empty row", () => {
    // Only a non-required field can reach this state — the API refuses locking
    // a required one with nothing behind it (`locked_required_field_empty`).
    const html = form({ values: {}, locked_fields: ["tone"] });
    expect(html).toContain('data-testid="locked-input-tone"');
    expect(html).toContain("—");
  });

  it("keeps a locked field out of both editable sections", () => {
    const html = form({ values: {}, locked_fields: ["query", "folder", "tone"] });
    expect(html).toContain('data-testid="locked-input-fields"');
    expect(html).not.toContain('data-testid="prompted-input-fields"');
    expect(html).not.toContain('data-testid="advanced-input-toggle"');
  });
});
