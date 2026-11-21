// SPDX-License-Identifier: Apache-2.0

/**
 * The organization offer on a package's sheet: its switch shows only to a reader who may change
 * the offer (or read-only while it stands), the requests are `PUT`/`DELETE …/org-offer`, and a
 * space running the package through the offer says so. The harness renders static markup, so
 * the withdrawal's confirmation (a portal) is covered by its wording.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { LibraryPackageItem, LibrarySpace } from "../../hooks/use-library.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { OrgOfferRow } = await import("../org-offer-row.tsx");
const { CataloguePreview } = await import("../catalogue-preview.tsx");
const { cataloguePlacement } = await import("../../lib/catalogue-placement.ts");
const { setOrgOffer } = await import("../../hooks/use-library.ts");
const { client } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const SPACES: LibrarySpace[] = [
  { id: "spc_a", name: "Alpha", isDefault: true },
  { id: "spc_b", name: "Beta", isDefault: false },
];

function pkg(overrides: Partial<LibraryPackageItem> = {}): LibraryPackageItem {
  return {
    id: "@acme/notes",
    type: "skill",
    source: "local",
    name: "Notes",
    description: "",
    home_space_id: "spc_a",
    home_writable: true,
    home_deletable: true,
    home_shareable: true,
    offered_to_org: false,
    org_offerable: true,
    activation: [],
    placements: [{ space_id: "spc_a", via: "home", state: "active", shared_by: null }],
    ...overrides,
  };
}

describe("the organization offer switch", () => {
  it("is offered to a reader who may change the offer", () => {
    const html = render(<OrgOfferRow item={pkg()} />);
    expect(html).toContain(settingsFr["catalogue.orgOffer.label"]);
    expect(html).toContain('role="switch"');
    expect(html).not.toContain(" disabled=");
  });

  it("is hidden when the package is not offerable and not offered", () => {
    const html = render(<OrgOfferRow item={pkg({ org_offerable: false })} />);
    expect(html).toBe("");
  });

  it("shows a standing offer read-only to a reader who may not change it", () => {
    const html = render(<OrgOfferRow item={pkg({ org_offerable: false, offered_to_org: true })} />);
    expect(html).toContain(settingsFr["catalogue.orgOffer.label"]);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(" disabled=");
  });
});

describe("the offer switch of another page", () => {
  it("takes the minimal shape, not a library entry", () => {
    const html = render(
      <OrgOfferRow
        item={{ id: "@acme/gmail", name: "Gmail", offered_to_org: true, org_offerable: true }}
      />,
    );
    expect(html).toContain(settingsFr["catalogue.orgOffer.label"]);
    expect(html).toContain('aria-checked="true"');
  });
});

describe("the withdrawal's wording", () => {
  it("states plainly that spaces stop and their schedules are disabled", () => {
    expect(settingsFr["catalogue.orgOffer.withdrawConfirm"]).toContain("planifications");
    expect(settingsFr["catalogue.orgOffer.withdrawConfirm"]).toContain("s'arrêtera");
  });
});

describe("setOrgOffer", () => {
  afterEach(() => mock.restore());
  const ok = { response: new Response(null, { status: 200 }) } as never;

  it("offers with PUT …/org-offer", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue(ok);
    const del = spyOn(client, "DELETE").mockResolvedValue(ok);
    await setOrgOffer("@acme/notes", true);
    expect(put).toHaveBeenCalledWith("/api/packages/{scope}/{name}/org-offer", {
      params: { path: { scope: "@acme", name: "notes" } },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("withdraws with DELETE …/org-offer", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue(ok);
    const del = spyOn(client, "DELETE").mockResolvedValue(ok);
    await setOrgOffer("@acme/notes", false);
    expect(del).toHaveBeenCalledWith("/api/packages/{scope}/{name}/org-offer", {
      params: { path: { scope: "@acme", name: "notes" } },
    });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("the sheet's spaces", () => {
  function sheet(item: LibraryPackageItem): string {
    return render(
      <CataloguePreview
        item={item}
        type="skill"
        icon={null}
        spaces={SPACES}
        placement={cataloguePlacement(item, "spc_a")}
        gateOf={() => ({ allowed: true, refusal: null })}
        integrations={[]}
        agents={[]}
        busy={false}
        onSetActive={() => {}}
      />,
      { queryClient: new QueryClient() },
    );
  }

  it("labels a space that runs it through the offer", () => {
    const html = sheet(
      pkg({
        offered_to_org: true,
        placements: [
          { space_id: "spc_a", via: "home", state: "active", shared_by: null },
          { space_id: "spc_b", via: "organization", state: "active", shared_by: null },
        ],
      }),
    );
    expect(html).toContain(settingsFr["catalogue.sheet.viaOrganization"]);
  });

  it("keeps a space that switched the offer off showing as off", () => {
    const html = sheet(
      pkg({
        offered_to_org: true,
        placements: [
          { space_id: "spc_a", via: "home", state: "active", shared_by: null },
          { space_id: "spc_b", via: "shared", state: "inactive", shared_by: null },
        ],
      }),
    );
    expect(html).not.toContain(settingsFr["catalogue.sheet.viaOrganization"]);
    expect(html).toContain(settingsFr["catalogue.filter.inactive"]);
  });
});
