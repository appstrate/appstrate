// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { QueryClient, type MutationObserver } from "@tanstack/react-query";
import { $api, client, type components } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { WorkspaceSettingsGeneralPage } from "../workspace-settings/general.tsx";
import { ROUTE_ACCESS, routeVerdict } from "../../lib/route-access.ts";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

type Space = components["schemas"]["SpaceObject"];

const ORG: components["schemas"]["Organization"] = {
  id: "org_general",
  name: "General",
  slug: "general",
  icon: null,
  color: null,
  role: "owner",
  deleting_at: null,
  // Neither the org nor the space grants `space-settings:write`, the route's permission.
  permissions: ["org:read", "spaces:delete"],
  createdAt: "2026-09-05T00:00:00Z",
};

function spaceFixture(personal: boolean, domains: string[] = []): Space {
  return {
    object: "space",
    id: "spc_general",
    orgId: ORG.id,
    name: personal ? "Mon espace" : "Equipe",
    icon: null,
    color: null,
    isDefault: false,
    settings: { allowedRedirectDomains: domains },
    visibility: personal ? "private" : "open",
    default_role: "viewer",
    credential_proxy_open: true,
    personal,
    access: "member",
    role: null,
    permissions: [],
    created_by: null,
    createdAt: ORG.createdAt,
    updatedAt: ORG.createdAt,
  };
}

/** `node` rendered as the page with `space` cached and current, on `queryClient`. */
function renderPage(space: Space, node: ReactElement, queryClient: QueryClient): string {
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG.id,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: space.id,
  });
  const header = { "X-Org-Id": ORG.id };
  queryClient.setQueryData(["orgs"], [ORG]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header } }).queryKey,
    { object: "list", data: [space], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}", { params: { path: { id: space.id }, header } })
      .queryKey,
    space,
  );
  try {
    return render(node, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
}

function generalPage(personal: boolean, domains: string[] = []): string {
  return renderPage(
    spaceFixture(personal, domains),
    <WorkspaceSettingsGeneralPage />,
    newQueryClient(),
  );
}

const SWITCH_ID = "space-credential-proxy-open";
type SwitchProps = {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** The props of the element whose `id` is `id`, searched through every element-valued prop. */
function propsWithId(node: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsWithId(child, id);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.props.id === id) return node.props;
  for (const value of Object.values(node.props)) {
    const found = propsWithId(value, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The page's form drawn once, then once more after the switch was set to `toggleTo` during the
 * first draw (a state update during render: React draws it again with the edited value). The
 * form's hooks run as the probe's own, so its element tree is reachable.
 */
function toggledPage(toggleTo: boolean, queryClient: QueryClient) {
  const draws: Array<SwitchProps | undefined> = [];
  function Probe(): ReactNode {
    const page = WorkspaceSettingsGeneralPage();
    if (!isValidElement<Record<string, unknown>>(page) || typeof page.type !== "function") {
      throw new Error("the page should draw its form");
    }
    const tree = (page.type as (props: Record<string, unknown>) => ReactNode)(page.props);
    const toggle = propsWithId(tree, SWITCH_ID) as SwitchProps | undefined;
    draws.push(toggle);
    if (draws.length === 1) toggle?.onCheckedChange(toggleTo);
    return tree;
  }
  const html = renderPage(spaceFixture(false), <Probe />, queryClient);
  return { html, draws };
}

/** The switch's opening tag in the static markup. */
function switchTag(html: string): string {
  const tag = html.match(new RegExp(`<button[^>]*id="${SWITCH_ID}"[^>]*>`));
  if (!tag) throw new Error("no direct access switch");
  return tag[0];
}

type PatchCall = [string, { params: { path: { id: string } }; body: unknown }];

describe("a workspace's general settings", () => {
  it("keeps only the name and one sentence for a personal workspace", () => {
    const html = generalPage(true);
    expect(html).toContain("Nom");
    expect(html).toContain("toujours privé");
    expect(html).not.toContain("Visibilité");
    expect(html).not.toContain("Domaines de redirection");
    expect(html).not.toContain("Zone de danger");
    expect(html).not.toContain('role="radiogroup"');
    // The server refuses an icon or a colour on a personal space: it is drawn as its owner.
    expect(html).not.toContain("Icône et couleur");
  });

  it("shows every setting of a team workspace", () => {
    const html = generalPage(false);
    expect(html).toContain("Visibilité");
    expect(html).toContain("Domaines de redirection");
    expect(html).toContain("Rôle des accès automatiques");
    expect(html).toContain("Zone de danger");
    expect(html).toContain("Icône et couleur");
    expect(html).not.toContain("toujours privé");
  });

  it("labels each redirect domain and its remove button", () => {
    const html = generalPage(false, ["a.example", "b.example"]);
    expect(html).toContain('aria-label="Domaine de redirection 1"');
    expect(html).toContain('aria-label="Domaine de redirection 2"');
    expect(html.split('aria-label="Retirer ce domaine"')).toHaveLength(3);
  });
});

describe("the direct access switch of a workspace", () => {
  it("writes { credential_proxy_open: false } at once and shows the switch off", async () => {
    const patch = spyOn(client, "PATCH").mockResolvedValue({
      data: { ...spaceFixture(false), credential_proxy_open: false },
      response: new Response(null, { status: 200 }),
    });
    try {
      const { draws, html } = toggledPage(false, newQueryClient());
      expect(draws[0]?.checked).toBe(true);
      expect(draws[draws.length - 1]?.checked).toBe(false);
      // Off, and held while the write is in flight.
      expect(switchTag(html)).toContain('data-state="unchecked"');
      expect(switchTag(html)).toContain(' disabled=""');
      await Bun.sleep(0);
      const calls = patch.mock.calls as unknown as PatchCall[];
      expect(calls.map(([path, init]) => [path, init.params.path.id, init.body])).toEqual([
        ["/api/spaces/{id}", "spc_general", { credential_proxy_open: false }],
      ]);
    } finally {
      patch.mockRestore();
    }
  });

  it("toasts a refused write the way the page's other single choices do", async () => {
    const refusal = new ApiError("forbidden", "no", 403);
    const patch = spyOn(client, "PATCH").mockRejectedValue(refusal);
    const toasted = spyOn(toast, "error").mockImplementation(() => 0);
    const queryClient = newQueryClient();
    // A static render subscribes no observer, and a mutation calls the per-call `onError` only
    // for a subscribed one: subscribe the form's observer as a mounted page would.
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "observerAdded") {
        (event.observer as MutationObserver<unknown, unknown, unknown, unknown>).subscribe(
          () => {},
        );
      }
    });
    try {
      toggledPage(false, queryClient);
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(patch).toHaveBeenCalledTimes(1);
      expect(toasted).toHaveBeenCalledTimes(1);
      expect(toasted.mock.calls[0]?.[0]).toBe(i18n.t("apiError.forbidden", { ns: "common" }));
      // Nothing was written to the cache: the page drawn again shows the stored value.
      const again = toggledPage(true, queryClient).draws[0];
      expect(again?.checked).toBe(true);
    } finally {
      unsubscribe();
      toasted.mockRestore();
      patch.mockRestore();
    }
  });

  it("is absent from a personal workspace", () => {
    expect(generalPage(true)).not.toContain(`id="${SWITCH_ID}"`);
    expect(generalPage(false)).toContain(`id="${SWITCH_ID}"`);
  });

  it("is gated by the route, not by the page: the page draws it enabled for any caller", () => {
    // The fixture grants neither `space-settings:write` nor any space permission.
    const tag = switchTag(generalPage(false));
    expect(tag).toContain('data-state="checked"');
    expect(tag).not.toContain(' disabled=""');
    // The route itself is refused to that caller.
    expect(ROUTE_ACCESS["/workspace-settings/general"].anyOf).toEqual(["space-settings:write"]);
    const can = (permission: string) => ORG.permissions.includes(permission);
    expect(routeVerdict("/workspace-settings/general", can, {}, false)).toBe("denied");
  });
});
