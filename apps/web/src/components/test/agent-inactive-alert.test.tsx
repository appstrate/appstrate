// SPDX-License-Identifier: Apache-2.0

/**
 * What the detail page of a switched-off agent says, and to whom.
 *
 * The page opens in full for such an agent — reading and configuring a package
 * is not running it, so every read route answers 200 and only the execution
 * doors refuse — and the server reports the blockage on the readiness read
 * (`agent_not_active`, 200) rather than 404-ing the panel that would have
 * displayed it. This banner is that display: ONE line of state and a switch,
 * because the reader arrived from the space library or from a kept link, both
 * of which already say the package is off here. Two halves are worth pinning:
 * it states the blockage to everyone, and it offers the switch only to a caller
 * the activation route would actually accept (`maySetPackageActive`: the type's
 * grant in THIS space, or owning it — RBAC spec §3.6, where a guest holds
 * `operator` in their own space and `operator` carries no `agents:configure`).
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AgentInactiveAlert } = await import("../package-detail/agent-inactive-alert.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { render } = await import("../../test/render.tsx");
const { $api } = await import("../../api/client.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const i18n = i18nModule.default;
const ORG_ID = "org_a";
const SPACE_ID = "spc_a";

/** One row of `GET /api/spaces`, in the shape the activation verdict reads. */
function spaceRow(overrides: { permissions: string[]; personal?: boolean }) {
  return {
    object: "space",
    id: SPACE_ID,
    orgId: ORG_ID,
    name: "Default",
    isDefault: true,
    settings: {},
    visibility: "open",
    default_role: "viewer",
    personal: overrides.personal ?? false,
    access: "member",
    role: null,
    permissions: overrides.permissions,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

function renderAlert(space: ReturnType<typeof spaceRow>): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    { object: "list", data: [space], hasMore: false },
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const current = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<AgentInactiveAlert packageId="@acme/worker" />, { queryClient });
  } finally {
    org.mockRestore();
    current.mockRestore();
  }
}

/** The activation control, by the label it carries. */
function hasActivateButton(html: string): boolean {
  const label = i18n.t("detail.activate", { ns: "agents" });
  return html
    .split("<button")
    .slice(1)
    .some((chunk) => chunk.slice(0, chunk.indexOf("</button>")).includes(label));
}

describe("the switched-off banner", () => {
  it("states the blockage and offers the switch to a caller who may flip it", () => {
    const html = renderAlert(spaceRow({ permissions: ["agents:configure"] }));
    expect(html).toContain(i18n.t("detail.deactivatedHere", { ns: "agents" }));
    expect(hasActivateButton(html)).toBe(true);
  });

  it("offers it in the caller's OWN space, where no grant says so", () => {
    // §3.6: owning the space IS the authorization. A personal space is reached
    // by its owner alone, so `personal && access: "member"` is "this one is
    // mine" — the fact that stands in for an owner id the wire withholds.
    const html = renderAlert(spaceRow({ permissions: [], personal: true }));
    expect(hasActivateButton(html)).toBe(true);
  });

  it("CONTROL: states the blockage alone when the caller may not flip it", () => {
    // Same banner, a team space where this caller holds the read and nothing
    // else: the sentence stays, the cure goes — naming a remedy the route
    // would refuse is worse than naming none.
    const html = renderAlert(spaceRow({ permissions: ["agents:read"] }));
    expect(html).toContain(i18n.t("detail.deactivatedHere", { ns: "agents" }));
    expect(hasActivateButton(html)).toBe(false);
  });
});
