// SPDX-License-Identifier: Apache-2.0

/**
 * The detected-models list, rendered on its own.
 *
 * It is unreachable from a static render of the form — the list appears only
 * after the detect button is clicked and the endpoint has answered — so what it
 * shows is asserted here instead of faked over there. What matters per row is
 * that it never claims more than the description carried: a provenance badge
 * only where `source` names one, a context window only where the listing (or
 * the catalog) reported one.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { DiscoveredModelList } from "../discovered-model-list.tsx";
import type { DiscoveredModel } from "../../../hooks/use-model-provider-credentials.ts";

await i18nReady;
await i18n.changeLanguage("fr");

function discovered(overrides: Partial<DiscoveredModel> & { id: string }): DiscoveredModel {
  return {
    label: null,
    context_window: null,
    max_tokens: null,
    input: null,
    reasoning: null,
    source: null,
    ...overrides,
  };
}

const FROM_ENDPOINT = discovered({
  id: "qwen3:8b",
  label: "Qwen 3 8B",
  context_window: 32768,
  source: "endpoint",
});
const FROM_CATALOG = discovered({ id: "llama3", context_window: 8192, source: "catalog" });
const UNDESCRIBED = discovered({ id: "mystery-model" });

function list(selectedIds: string[] = []): string {
  return render(
    <DiscoveredModelList
      models={[FROM_ENDPOINT, FROM_CATALOG, UNDESCRIBED]}
      selectedIds={selectedIds}
      onSelectionChange={() => {}}
    />,
  );
}

describe("DiscoveredModelList", () => {
  it("names every model the endpoint served, and offers them all at once", () => {
    const html = list();
    expect(html).toContain(settingsFr["models.form.discoverSelectAll"]);
    expect(html).toContain("Qwen 3 8B");
    expect(html).toContain("qwen3:8b");
    expect(html).toContain("llama3");
    expect(html).toContain("mystery-model");
  });

  it("says where each description came from, and stays silent when nothing did", () => {
    const html = list();
    expect(html).toContain(settingsFr["models.form.discoverSourceEndpoint"]);
    expect(html).toContain(settingsFr["models.form.discoverSourceCatalog"]);
    // One badge each, and none for the model neither source described.
    const badges = html.split(settingsFr["models.form.discoverSourceCatalog"]).length - 1;
    expect(badges).toBe(1);
  });

  it("shows a context window only for the models that reported one", () => {
    const html = list();
    expect(html).toContain("33k");
    expect(html).toContain("8k");
    const row = html.slice(html.indexOf("mystery-model"));
    expect(row).not.toContain("k</span>");
  });

  it("checks exactly the picked rows", () => {
    const html = list([FROM_CATALOG.id]);
    expect(html.split('aria-checked="true"').length - 1).toBe(1);
  });

  it("checks the select-all box once every row is picked", () => {
    const html = list([FROM_ENDPOINT.id, FROM_CATALOG.id, UNDESCRIBED.id]);
    // Three rows plus the toggle above them.
    expect(html.split('aria-checked="true"').length - 1).toBe(4);
  });
});
