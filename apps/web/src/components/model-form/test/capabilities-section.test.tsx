// SPDX-License-Identifier: Apache-2.0

/**
 * The capabilities section is a toggle over two mutually exclusive readings of
 * the same form. Off, there is nothing to fill in and the fallback chain is
 * stated instead — the point being that a blank field is NOT what makes a
 * model text-only, the runtime default is. On, every field is on screen and an
 * unticked box is an answer rather than an omission, which is exactly what the
 * payload builder pins on the other side (`lib/test/model-form-payload.test.ts`).
 */

import { describe, it, expect } from "bun:test";
import type { UseFormRegisterReturn } from "react-hook-form";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { CapabilitiesSection } from "../capabilities-section.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const fieldProps = (name: string): UseFormRegisterReturn => ({
  name,
  onChange: async () => true,
  onBlur: async () => true,
  ref: () => {},
});

function section(explicit: boolean, values: { inputImage?: boolean; reasoning?: boolean } = {}) {
  return render(
    <CapabilitiesSection
      explicit={explicit}
      contextWindowProps={fieldProps("contextWindow")}
      maxTokensProps={fieldProps("maxTokens")}
      inputText
      inputImage={values.inputImage ?? false}
      reasoning={values.reasoning ?? false}
      onExplicitChange={() => {}}
      onInputTextChange={() => {}}
      onInputImageChange={() => {}}
      onReasoningChange={() => {}}
    />,
  );
}

describe("CapabilitiesSection — off", () => {
  const html = section(false);

  it("states what answers for the model instead of the operator", () => {
    expect(html).toContain(settingsFr["models.form.capabilitiesAuto"]);
  });

  it("puts no field on screen — there is nothing half-filled to misread", () => {
    for (const id of [
      "mdl-ctx",
      "mdl-maxtok",
      "mdl-input-text",
      "mdl-input-image",
      "mdl-reasoning",
    ])
      expect(html).not.toContain(`id="${id}"`);
  });

  it("shows the toggle unchecked", () => {
    expect(html).toContain('id="mdl-capabilities-explicit"');
    expect(html).toContain(settingsFr["models.form.capabilitiesExplicit"]);
    expect(checkedState(html, "mdl-capabilities-explicit")).toBe("false");
  });
});

describe("CapabilitiesSection — on", () => {
  const html = section(true, { inputImage: true });

  it("groups the two questions it asks: the limits, then the modalities", () => {
    const order = [
      settingsFr["models.form.capabilitiesLimits"],
      'id="mdl-ctx"',
      'id="mdl-maxtok"',
      settingsFr["models.form.capabilitiesAccepts"],
      'id="mdl-input-text"',
      'id="mdl-input-image"',
      'id="mdl-reasoning"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("drops the auto sentence, which no longer describes what will be saved", () => {
    expect(html).not.toContain(settingsFr["models.form.capabilitiesAuto"]);
  });

  it("suggests the runtime's own fallbacks as the placeholders", () => {
    // `runtime-pi/env.ts` — 128k context, 16k output. The old 200000 hint
    // described no default the platform actually applies.
    expect(html).toContain('placeholder="128000"');
    expect(html).toContain('placeholder="16384"');
  });

  it("renders each box on its stored value", () => {
    expect(checkedState(html, "mdl-input-text")).toBe("true");
    expect(checkedState(html, "mdl-input-image")).toBe("true");
    expect(checkedState(html, "mdl-reasoning")).toBe("false");
  });
});

/** A Radix checkbox is a `button`, so its state reads off `aria-checked`. */
function checkedState(html: string, id: string): string | undefined {
  const tag = html.slice(html.lastIndexOf("<button", html.indexOf(`id="${id}"`)));
  return /aria-checked="(\w+)"/.exec(tag.slice(0, tag.indexOf(">")))?.[1];
}
