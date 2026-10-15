// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentListPanel } from "../document-list-panel.tsx";
import { ListFooter } from "../list-toolbar.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("the documents panel", () => {
  it("keeps the honest footer on an empty result", () => {
    const html = render(
      <QueryClientProvider client={new QueryClient()}>
        <DocumentListPanel
          documents={[]}
          isLoading={false}
          error={null}
          empty={{ message: "Aucun résultat", compact: true }}
          footer={<ListFooter count="0 document · 2.2 GB utilisés" />}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("Aucun résultat");
    expect(html).toContain("0 document · 2.2 GB utilisés");
  });
});
