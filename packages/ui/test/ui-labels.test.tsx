// SPDX-License-Identifier: Apache-2.0

/**
 * The copy button rendered OUTSIDE a host that provides `UiLabelsContext` — a module's own modal
 * mounted on its own, a test — still has a label: the context's default is the English set,
 * never an empty string or a missing accessible name.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton } from "../src/components/copy-button.tsx";
import { Breadcrumb, BreadcrumbEllipsis } from "../src/components/breadcrumb.tsx";
import { UiLabelsContext } from "../src/components/ui-labels.ts";

const button = <CopyButton value="x" />;

describe("UiLabelsContext", () => {
  it("falls back to English without a provider", () => {
    expect(renderToStaticMarkup(button)).toContain("Copy");
  });

  it("renders the host's labels under a provider", () => {
    const html = renderToStaticMarkup(
      <UiLabelsContext.Provider
        value={{ copy: "Copier", copied: "Copié", copyFailed: "Copie impossible." }}
      >
        {button}
      </UiLabelsContext.Provider>,
    );
    expect(html).toContain("Copier");
    expect(html).not.toContain(">Copy<");
  });

  it("names the breadcrumb and its ellipsis from the host's labels", () => {
    const trail = (
      <Breadcrumb>
        <BreadcrumbEllipsis />
      </Breadcrumb>
    );
    expect(renderToStaticMarkup(trail)).toContain('aria-label="Breadcrumb"');
    const html = renderToStaticMarkup(
      <UiLabelsContext.Provider
        value={{
          close: "Fermer",
          sidebar: "",
          sidebarDescription: "",
          toggleSidebar: "",
          breadcrumb: "Fil d'Ariane",
          breadcrumbMore: "Plus d'éléments",
          copy: "",
          copied: "",
          copyFailed: "",
        }}
      >
        {trail}
      </UiLabelsContext.Provider>,
    );
    expect(html).toContain("Fil d&#x27;Ariane");
    expect(html).toContain("Plus d&#x27;éléments");
  });
});
