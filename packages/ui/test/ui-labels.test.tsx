// SPDX-License-Identifier: Apache-2.0

/**
 * The copy button rendered OUTSIDE a host that provides `UiLabelsContext` — a module's own modal
 * mounted on its own, a test — still has a label: the context's default is the English set,
 * never an empty string or a missing accessible name.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton } from "../src/components/copy-button.tsx";
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
});
