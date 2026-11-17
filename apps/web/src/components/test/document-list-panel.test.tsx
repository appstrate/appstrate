// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import type { ComponentProps } from "react";
import { ApiError } from "../../api/errors.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentListPanel } from "../document-list-panel.tsx";
import { ListFooter } from "../list-toolbar.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { fileFixture, render } from "../../test/render.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";

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

describe("a list spanning spaces", () => {
  /** Renders standing in `spc_1` of `org_1`: a static render reads each store's initial state. */
  function inSpace1(node: React.ReactElement): string {
    const stubs = [
      spyOn(orgStore, "getInitialState").mockReturnValue({
        ...orgStore.getInitialState(),
        id: "org_1",
      }),
      spyOn(spaceStore, "getInitialState").mockReturnValue({
        ...spaceStore.getInitialState(),
        id: "spc_1",
      }),
    ];
    try {
      return render(node);
    } finally {
      for (const stub of stubs) stub.mockRestore();
    }
  }
  const elsewhere = fileFixture({
    ...file,
    id: "file_ailleurs",
    name: "ailleurs.txt",
    spaceId: "spc_2",
  });
  const panel = (spanning: boolean) =>
    inSpace1(
      <DocumentListPanel
        documents={[file, elsewhere]}
        isLoading={false}
        error={null}
        empty={{ message: "Vide" }}
        spanning={spanning}
      />,
    );

  it("opens a file of another space in the reader, in its own space, without switching", () => {
    const html = panel(true);
    expect(html).toContain(`href="/files/${elsewhere.id}?org=org_1&amp;space=spc_2"`);
    // The current space's file keeps its in-place preview.
    expect(html).not.toContain(`href="/files/${file.id}?`);
  });

  it("names each row's space in a column, only when spanning", () => {
    expect(panel(true)).toContain('data-column="space"');
    expect(panel(false)).not.toContain('data-column="space"');
  });

  it("offers each row the writes its own space grants, spanning or not", () => {
    // Keep and delete are its only deeds: its « … » menu shows exactly when one is offered.
    const writable = fileFixture({
      ...file,
      expiresAt: "2026-12-01T00:00:00.000Z",
      capabilities: {
        ...file.capabilities,
        download: false,
        preview: false,
        keep: true,
        delete: true,
      },
    });
    const rows = (spanning: boolean) =>
      inSpace1(
        <DocumentListPanel
          documents={[
            writable,
            { ...writable, id: "file_ailleurs", name: "ailleurs.txt", spaceId: "spc_2" },
            {
              ...writable,
              id: "file_lu",
              name: "lu.txt",
              spaceId: "spc_3",
              capabilities: { ...writable.capabilities, keep: false, delete: false },
            },
          ]}
          display="compact"
          isLoading={false}
          error={null}
          empty={{ message: "Vide" }}
          spanning={spanning}
        />,
      );
    for (const spanning of [false, true]) {
      const html = rows(spanning);
      expect(html).toContain(`Plus d'actions pour ${writable.name}`);
      expect(html).toContain("Plus d'actions pour ailleurs.txt");
      // Its space grants it neither.
      expect(html).not.toContain("Plus d'actions pour lu.txt");
    }
  });
});
