// SPDX-License-Identifier: Apache-2.0

/** A tool approved in this space reads « Approuvé » only while that approval is what the space uses. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { PackageToolCatalog, type PackageTool } from "../package-tool-catalog.tsx";

await i18nReady;
installFakeStorage({});

const APPROVED = "Approuvé dans cet espace";

function renderTool(tool: Partial<PackageTool>): string {
  return render(
    <PackageToolCatalog tools={[{ name: "export_notes", origin: "approved", ...tool }]} />,
  );
}

describe("PackageToolCatalog, approved tools", () => {
  it("marks an available approved tool", () => {
    expect(renderTool({ status: "available" })).toContain(APPROVED);
  });

  it("drops the mark once the definition moved and the tool waits for a new approval", () => {
    const html = renderTool({ status: "pending", modified: true });
    expect(html).not.toContain(APPROVED);
    expect(html).toContain("En attente d’approbation dans cet espace");
  });

  it("drops the mark on a blocked tool", () => {
    expect(renderTool({ status: "blocked" })).not.toContain(APPROVED);
  });
});
