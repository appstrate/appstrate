// SPDX-License-Identifier: Apache-2.0

/**
 * The space default's usage mode: a stored default whose members are all unshared has nothing the
 * server accepts to write a mode change with, so the section says so instead of a draft that
 * reads as saved.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { IntegrationConnection } from "../../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { OrgDefaultSection } = await import("../org-default-section.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { render } = await import("../../../test/render.tsx");
const { $api } = await import("../../../api/client.ts");
const i18nModule = await import("../../../i18n.ts");
const settingsFr = (await import("../../../locales/fr/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";
const INTEGRATION = "@acme/gmail";
const HEADER = { "X-Org-Id": ORG_ID, "X-Space-Id": SPACE_ID };
const SHARED = "11111111-1111-4111-8111-111111111111";
const GONE = "33333333-3333-4333-8333-333333333333";

function connection(id: string): IntegrationConnection {
  return {
    id,
    auth_key: "primary",
    account_id: "root@web",
    label: "web",
    owner_user_id: "usr_me",
    owner_end_user_id: null,
    owner_name: "Moi",
    scopes_granted: [],
    scope: "org",
    spaceId: null,
    shared_here: true,
    shared_space_ids: [SPACE_ID],
    origin_space_id: null,
    needs_reconnection: false,
  } as unknown as IntegrationConnection;
}

function section(storedIds: string[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    {
      object: "list",
      hasMore: false,
      data: [
        {
          object: "space",
          id: SPACE_ID,
          orgId: ORG_ID,
          name: "Default",
          isDefault: true,
          settings: {},
          visibility: "open",
          default_role: "viewer",
          personal: false,
          access: "member",
          role: null,
          permissions: ["integrations:read", "integrations:configure"],
          created_by: null,
          createdAt: "2026-09-05T10:00:00Z",
          updatedAt: "2026-09-05T10:00:00Z",
        },
      ],
    },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}/default", {
      params: { path: { packageId: INTEGRATION }, header: HEADER },
    }).queryKey,
    { integration_id: INTEGRATION, connection_ids: storedIds, enforce: false },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}/connections", {
      params: { path: { packageId: INTEGRATION }, header: HEADER },
    }).queryKey,
    { object: "list", hasMore: false, data: [connection(SHARED)] },
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<OrgDefaultSection packageId={INTEGRATION} />, { queryClient: qc });
  } finally {
    org.mockRestore();
    space.mockRestore();
  }
}

describe("the space default's usage mode", () => {
  it("asks for shared connections before a mode change when every stored one is unshared", () => {
    const html = section([GONE]);
    expect(html).toContain('data-testid="org-default-mode-locked"');
    expect(html).toContain(settingsFr["integration.admin.orgDefault.pickBeforeMode"]);
  });

  it("lets the mode change while a stored connection is still shared", () => {
    expect(section([SHARED, GONE])).not.toContain('data-testid="org-default-mode-locked"');
  });
});
