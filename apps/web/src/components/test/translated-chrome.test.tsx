// SPDX-License-Identifier: Apache-2.0

/**
 * The strings the design system renders by itself — a JSON-Schema form's validation messages,
 * the sidebar's screen-reader chrome — follow the active language instead of staying in the
 * package's English defaults.
 *
 * `@appstrate/ui/schema-form` is deliberately NOT imported here: the SPA loads it through
 * `lazy()`, and a suite that resolves the module eagerly changes what every later suite of the
 * run renders for it (`agent-input-form.test.tsx` asserts on the Suspense fallback).
 */

import { describe, expect, it } from "bun:test";
import { SidebarProvider, SidebarTrigger } from "@appstrate/ui/components/sidebar";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { useSchemaFormLabels } from "../../hooks/use-schema-form-labels.ts";
import { TranslatedUiLabels } from "../translated-ui-labels.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

/** Prints what the form would show for one failed Ajv keyword. */
function ValidationMessage({ keyword, params }: { keyword: string; params: object }) {
  const message = useSchemaFormLabels().validationError(keyword, { ...params });
  return <p>{message ?? "(Ajv's own message)"}</p>;
}

describe("SchemaForm in French", () => {
  it("translates a failed keyword with its Ajv params", () => {
    expect(render(<ValidationMessage keyword="type" params={{ type: "number" }} />)).toContain(
      "La valeur n'a pas le type attendu.",
    );
    expect(render(<ValidationMessage keyword="minLength" params={{ limit: 3 }} />)).toContain(
      "Saisissez au moins 3 caractère(s).",
    );
  });

  it("leaves a keyword it has no sentence for to Ajv", () => {
    expect(render(<ValidationMessage keyword="dependentRequired" params={{}} />)).toContain(
      "(Ajv's own message)",
    );
  });
});

describe("design-system chrome in French", () => {
  it("labels the sidebar trigger", () => {
    const html = render(
      <TranslatedUiLabels>
        <SidebarProvider>
          <SidebarTrigger />
        </SidebarProvider>
      </TranslatedUiLabels>,
    );
    expect(html).toContain(i18n.t("common:nav.toggleSidebar"));
    expect(html).not.toContain("Toggle Sidebar");
  });
});
