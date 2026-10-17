// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ComponentProps } from "react";
import { ApiError } from "../../api/errors.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentListPanel } from "../document-list-panel.tsx";
import { ListFooter } from "../list-toolbar.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { fileFixture, render } from "../../test/render.tsx";

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

const file = fileFixture({
  name: "rapport.txt",
  capabilities: {
    visible: true,
    metadata: true,
    download: true,
    preview: true,
    keep: false,
    delete: false,
  },
});

it("offers a named preview and the shared action menu in the gallery grid", () => {
  const html = render(
    <DocumentListPanel
      documents={[file]}
      display="cards"
      isLoading={false}
      error={null}
      empty={{ message: "Vide" }}
    />,
  );
  expect(html).toContain('aria-label="Aperçu: rapport.txt"');
  expect(html).toContain("Plus d'actions pour rapport.txt");
  expect(html).not.toContain("<table");
});

it("does not offer content actions for an opaque image", () => {
  const opaque = fileFixture({
    name: "Fichier privé",
    mime: "image/png",
    capabilities: {
      visible: true,
      metadata: false,
      download: false,
      preview: false,
      keep: false,
      delete: false,
    },
  });
  const html = render(
    <DocumentListPanel
      documents={[opaque]}
      display="cards"
      isLoading={false}
      error={null}
      empty={{ message: "Vide" }}
    />,
  );
  expect(html).toContain("Fichier privé");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<img");
});

it("offers a download when a file has no preview", () => {
  const html = render(
    <DocumentListPanel
      documents={[fileFixture({ name: "archive.zip" })]}
      display="cards"
      isLoading={false}
      error={null}
      empty={{ message: "Vide" }}
    />,
  );
  expect(html).toContain('aria-label="Télécharger: archive.zip"');
});

it("keeps the same empty and error states in the grid", () => {
  const props: Omit<ComponentProps<typeof DocumentListPanel>, "error"> = {
    documents: [],
    display: "cards",
    isLoading: false,
    empty: { message: "Vide" },
  };
  expect(render(<DocumentListPanel {...props} error={null} />)).toContain("Vide");
  const failed = render(
    <DocumentListPanel
      {...props}
      error={new ApiError("forbidden", "private server detail", 403)}
    />,
  );
  expect(failed).not.toContain("Vide");
  expect(failed).not.toContain("private server detail");
  expect(failed).toContain("Une erreur est survenue.");
});

describe("the grid excerpt", () => {
  const scope = { "X-Org-Id": undefined, "X-Space-Id": undefined };
  const seeded = (id: string, excerpt: string | null) => {
    const qc = new QueryClient();
    qc.setQueryData(
      ["get", "/api/files/{id}/excerpt", { params: { path: { id }, header: scope } }],
      { excerpt },
    );
    return qc;
  };
  const grid = (doc: ReturnType<typeof fileFixture>, qc: QueryClient) =>
    render(
      <DocumentListPanel
        documents={[doc]}
        display="cards"
        isLoading={false}
        error={null}
        empty={{ message: "Vide" }}
      />,
      { queryClient: qc },
    );

  it("shows the excerpt as escaped text", () => {
    const doc = fileFixture({ name: "note.txt", mime: "text/plain" });
    const html = grid(doc, seeded(doc.id, "Bonjour\n<b>x</b>"));
    expect(html).toContain("Bonjour");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("keeps the icon when there is no excerpt", () => {
    const doc = fileFixture({ name: "note.txt", mime: "text/plain" });
    expect(grid(doc, seeded(doc.id, null))).not.toContain("whitespace-pre-line");
    expect(grid(doc, new QueryClient())).not.toContain("whitespace-pre-line");
  });

  it("never asks for an excerpt the caller cannot download", () => {
    const doc = fileFixture({
      name: "note.txt",
      mime: "text/plain",
      capabilities: { ...file.capabilities, download: false, preview: false },
    });
    expect(grid(doc, seeded(doc.id, "secret"))).not.toContain("secret");
  });
});
