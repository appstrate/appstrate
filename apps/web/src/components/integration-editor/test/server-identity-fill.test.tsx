// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { ServerIdentityFill } from "../server-identity-fill.tsx";

await i18nReady;

function renderFill(blockedBy: "sse" | "no_permission" | "no_connection" | null) {
  return render(
    <ServerIdentityFill
      packageId="@acme/x"
      blockedBy={blockedBy}
      manifest={{}}
      onChange={() => {}}
    />,
  );
}

describe("ServerIdentityFill", () => {
  it("renders an enabled button when the server can be read", () => {
    const html = renderFill(null);
    expect(html).toContain("Reprendre l’identité du serveur");
    expect(html).toContain("integration-editor-identity-from-server-button");
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain('role="status"');
  });

  it.each([
    ["no_connection", "Connectez d’abord un compte pour lire le serveur."],
    ["no_permission", "Vous n’avez pas le droit d’utiliser une connexion"],
    ["sse", "Le transport SSE n’est pas pris en charge"],
  ] as const)("disables the button with the %s reason", (block, reason) => {
    const html = renderFill(block);
    expect(html).toContain("disabled=");
    expect(html).toContain(reason);
  });
});
