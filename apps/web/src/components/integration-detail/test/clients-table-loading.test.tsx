// SPDX-License-Identifier: Apache-2.0

/**
 * While the clients load the list is empty only because nothing has answered:
 * the manual-register toggle (shown for an auto-provisioned auth with no client)
 * must wait, and the « client utilisé » line holds its place as a skeleton so
 * the table is not pushed down when it lands.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { components } from "../../../api/client.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { ClientsTable } = await import("../clients-table.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { render } = await import("../../../test/render.tsx");
const { $api } = await import("../../../api/client.ts");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_c";
const SPACE_ID = "spc_c";
const PACKAGE = "@acme/gmail";
const HEADER = { "X-Org-Id": ORG_ID, "X-Space-Id": SPACE_ID };

function table({ loaded }: { loaded: boolean }): string {
  const qc = new QueryClient();
  const org: components["schemas"]["Organization"] = {
    id: ORG_ID,
    name: "C",
    slug: "c",
    icon: null,
    color: null,
    role: "member",
    deleting_at: null,
    permissions: ["integrations:read"],
    createdAt: "2026-09-05T00:00:00Z",
  };
  qc.setQueryData(["orgs"], [org]);
  if (loaded)
    qc.setQueryData(
      $api.queryOptions("get", "/api/integrations/{packageId}/auths/{authKey}/clients", {
        params: { path: { packageId: PACKAGE, authKey: "primary" }, header: HEADER },
      }).queryKey,
      { object: "list", hasMore: false, data: [] },
    );
  const orgSpy = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const spaceSpy = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<ClientsTable packageId={PACKAGE} authKey="primary" autoProvisioned />, {
      queryClient: qc,
    });
  } finally {
    orgSpy.mockRestore();
    spaceSpy.mockRestore();
  }
}

describe("ClientsTable while its clients load", () => {
  it("holds the manual-register toggle back and reserves the in-use line", () => {
    const html = table({ loaded: false });
    expect(html).not.toContain("oauth-client-manual-toggle-primary");
    expect(html).toContain("animate-pulse");
  });

  it("offers the manual toggle once an empty list has answered", () => {
    expect(table({ loaded: true })).toContain("oauth-client-manual-toggle-primary");
  });
});
