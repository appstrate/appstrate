// SPDX-License-Identifier: Apache-2.0

/**
 * The model pick list, rendered on its own.
 *
 * It is unreachable from a static render of the form — it appears only once an
 * endpoint is open and a listing has answered — so what it shows is asserted
 * here instead of faked over there. What matters per row is that it never
 * claims more than the description carried: a provenance badge only where
 * `source` names one, a context window only where one was reported.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { ModelPickList } from "../model-pick-list.tsx";
import type { ModelPickRow } from "../../../lib/model-source.ts";

await i18nReady;
await i18n.changeLanguage("fr");

function pickRow(overrides: Partial<ModelPickRow> & { id: string }): ModelPickRow {
  return {
    label: null,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: null,
    cost: null,
    origin: "discover",
    featured: false,
    ...overrides,
  };
}

const FROM_ENDPOINT = pickRow({
  id: "qwen3:8b",
  label: "Qwen 3 8B",
  contextWindow: 32768,
  source: "endpoint",
});
const FROM_CATALOG = pickRow({ id: "llama3", contextWindow: 8192, source: "catalog" });
const UNDESCRIBED = pickRow({ id: "mystery-model" });

function list(options: Partial<Parameters<typeof ModelPickList>[0]> = {}): string {
  return render(
    <ModelPickList
      rows={[FROM_ENDPOINT, FROM_CATALOG, UNDESCRIBED]}
      selectedIds={[]}
      onSelectionChange={() => {}}
      search=""
      onSearchChange={() => {}}
      isLoading={false}
      loadingText="…"
      emptyText={settingsFr["models.form.modelSearchEmpty"]}
      {...options}
    />,
  );
}

describe("ModelPickList", () => {
  it("names every model offered, and offers them all at once", () => {
    const html = list();
    expect(html).toContain(settingsFr["models.form.discoverSelectAll"]);
    expect(html).toContain('id="mdl-pick-all"');
    expect(html).toContain("Qwen 3 8B");
    expect(html).toContain("qwen3:8b");
    expect(html).toContain("llama3");
    expect(html).toContain("mystery-model");
    for (const index of [0, 1, 2]) expect(html).toContain(`id="mdl-pick-${index}"`);
  });

  it("puts a search box above the rows, whatever fills them", () => {
    const html = list({ search: "qwen" });
    expect(html).toContain('id="mdl-modelSearch"');
    expect(html).toContain(settingsFr["models.form.modelSearchPlaceholder"]);
    expect(html).toContain('value="qwen"');
  });

  it("says where each description came from, and stays silent when nothing did", () => {
    const html = list();
    expect(html).toContain(settingsFr["models.form.discoverSourceEndpoint"]);
    expect(html).toContain(settingsFr["models.form.discoverSourceCatalog"]);
    // One badge each, and none for the model neither source described.
    expect(html.split(settingsFr["models.form.discoverSourceCatalog"]).length - 1).toBe(1);
  });

  it("shows a context window only for the models that reported one", () => {
    const html = list();
    expect(html).toContain("33k");
    expect(html).toContain("8k");
    const row = html.slice(html.indexOf("mystery-model"));
    expect(row).not.toContain("k</span>");
  });

  it("checks exactly the picked rows", () => {
    expect(list({ selectedIds: [FROM_CATALOG.id] }).split('aria-checked="true"').length - 1).toBe(
      1,
    );
  });

  it("checks the select-all box once every row is picked", () => {
    const html = list({ selectedIds: [FROM_ENDPOINT.id, FROM_CATALOG.id, UNDESCRIBED.id] });
    // Three rows plus the toggle above them.
    expect(html.split('aria-checked="true"').length - 1).toBe(4);
  });
});

describe("ModelPickList — a catalog, in two groups", () => {
  const CURATED = pickRow({ id: "claude-opus-5", origin: "catalog", featured: true });
  const REST = pickRow({ id: "claude-3-opus-20240229", origin: "catalog" });
  const html = render(
    <ModelPickList
      rows={[REST, CURATED]}
      selectedIds={[]}
      onSelectionChange={() => {}}
      search=""
      onSearchChange={() => {}}
      isLoading={false}
      loadingText="…"
      emptyText="—"
      grouped
    />,
  );

  it("puts the provider's curated models first, under their own heading", () => {
    const order = [
      settingsFr["models.form.modelGroupFeatured"],
      CURATED.id,
      settingsFr["models.form.modelGroupAll"],
      REST.id,
    ].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps a row's id tied to its place in the whole list, not in its group", () => {
    // The curated row is second in `rows`, so it stays `mdl-pick-1` wherever
    // the grouping puts it — a selector written against the list survives it.
    expect(html.indexOf('id="mdl-pick-0"')).toBeGreaterThan(html.indexOf('id="mdl-pick-1"'));
  });
});

describe("ModelPickList — nothing to show", () => {
  it("states what it is waiting for rather than showing an empty frame", () => {
    expect(list({ rows: [], isLoading: true, loadingText: "Détection…" })).toContain("Détection…");
  });

  it("states why the list is empty once the answer is in", () => {
    const html = list({ rows: [] });
    expect(html).toContain(settingsFr["models.form.modelSearchEmpty"]);
  });
});
