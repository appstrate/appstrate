// SPDX-License-Identifier: Apache-2.0

/**
 * The picker's trigger names the chosen actor. While that name is unread (the
 * organization's members still loading) it is a skeleton, not the raw id; once
 * the member list is in, the member's name replaces it.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { ActorSelect } = await import("../actor-select.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const { $api } = await import("../../api/client.ts");
const i18nModule = await import("../../i18n.ts");
const { authStore } = await import("../../stores/auth-store.ts");

// Signed out, the session read settled: the state the boot resync leaves without a session.
authStore.setState({ user: null, profile: null, loading: false });

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_actor";
const USER_ID = "usr_ada_lovelace_1";

function trigger(members: unknown[] | null): string {
  const qc = new QueryClient();
  if (members)
    qc.setQueryData(
      $api.queryOptions("get", "/api/orgs/{orgId}", { params: { path: { orgId: ORG_ID } } })
        .queryKey,
      { id: ORG_ID, members, invitations: [] },
    );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(
      <ActorSelect value={{ userId: USER_ID }} onChange={() => {}} includeEndUsers={false} />,
      { queryClient: qc },
    );
  } finally {
    org.mockRestore();
  }
}

describe("ActorSelect trigger", () => {
  it("draws a skeleton, not the raw id, while the member's name is unread", () => {
    const html = trigger(null);
    expect(html).not.toContain(USER_ID);
    expect(html).toContain("animate-pulse");
  });

  it("names the member once the list is in", () => {
    const html = trigger([{ userId: USER_ID, displayName: "Ada", email: "ada@acme.test" }]);
    expect(html).toContain("Ada");
    expect(html).not.toContain("animate-pulse");
  });
});
