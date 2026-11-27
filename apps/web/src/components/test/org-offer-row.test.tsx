// SPDX-License-Identifier: Apache-2.0

/**
 * The organization offer on a package's sheet: its choice of mode shows only to a reader who may
 * change the offer (or as text while it stands), the requests are `PUT {mode}`/`DELETE …/org-offer`,
 * and a space running or awaiting the package through the offer says so. The harness renders static markup, so
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
const { offerChangeStep } = await import("../../lib/org-offer-change.ts");
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
    org_offer: null,
    org_offerable: true,
    active_by_default: false,
    activation: [],
    placements: [{ space_id: "spc_a", via: "home", state: "active", shared_by: null }],
    ...overrides,
  };
}

describe("the organization offer choice", () => {
  it("is offered to a reader who may change the offer, with no offer standing", () => {
    const html = render(<OrgOfferRow item={pkg()} />);
    expect(html).toContain(settingsFr["catalogue.orgOffer.label"]);
    expect(html).toContain('role="combobox"');
    expect(html).toContain(settingsFr["catalogue.orgOffer.helpNone"]);
    expect(html).not.toContain(" disabled=");
  });

  it("explains each standing mode to a reader who may change it", () => {
    const available = render(<OrgOfferRow item={pkg({ org_offer: "available" })} />);
    expect(available).toContain('role="combobox"');
    expect(available).toContain(settingsFr["catalogue.orgOffer.helpAvailable"]);
    const onByDefault = render(<OrgOfferRow item={pkg({ org_offer: "on_by_default" })} />);
    expect(onByDefault).toContain(settingsFr["catalogue.orgOffer.helpOnByDefault"]);
  });

  it("is hidden when the package is not offerable and not offered", () => {
    const html = render(<OrgOfferRow item={pkg({ org_offerable: false })} />);
    expect(html).toBe("");
  });

  it("shows a plain row, without a choice, on a package the deployment already activates", () => {
    const html = render(
      <OrgOfferRow item={pkg({ org_offerable: false, active_by_default: true })} />,
    );
    expect(html).toContain(settingsFr["catalogue.orgOffer.defaultActive"]);
    expect(html).not.toContain('role="combobox"');
  });

  it("keeps the choice on an existing offer of such a package, so it can be withdrawn", () => {
    const html = render(
      <OrgOfferRow
        item={pkg({ org_offer: "on_by_default", org_offerable: true, active_by_default: true })}
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain(settingsFr["catalogue.orgOffer.defaultActiveHelp"]);
  });

  it("shows a standing offer as text to a reader who may not change it", () => {
    const available = render(
      <OrgOfferRow item={pkg({ org_offerable: false, org_offer: "available" })} />,
    );
    expect(available).toContain(settingsFr["catalogue.orgOffer.modeAvailable"]);
    expect(available).not.toContain('role="combobox"');
    const onByDefault = render(
      <OrgOfferRow item={pkg({ org_offerable: false, org_offer: "on_by_default" })} />,
    );
    expect(onByDefault).toContain(settingsFr["catalogue.orgOffer.modeOnByDefault"]);
    expect(onByDefault).not.toContain('role="combobox"');
  });
});

describe("the offer row of another page", () => {
  it("takes the minimal shape, not a library entry", () => {
    const html = render(
      <OrgOfferRow
        item={{
          id: "@acme/gmail",
          name: "Gmail",
          org_offer: "on_by_default",
          org_offerable: true,
          active_by_default: false,
        }}
      />,
    );
    expect(html).toContain(settingsFr["catalogue.orgOffer.label"]);
    expect(html).toContain('role="combobox"');
  });
});

describe("what choosing a mode does", () => {
  it("writes straight away when offering, or going from available to on by default", () => {
    expect(offerChangeStep("none", "available")).toBe("apply");
    expect(offerChangeStep("none", "on_by_default")).toBe("apply");
    expect(offerChangeStep("available", "on_by_default")).toBe("apply");
  });

  it("asks first before withdrawing, or before going from on by default to available", () => {
    expect(offerChangeStep("available", "none")).toBe("confirm_withdraw");
    expect(offerChangeStep("on_by_default", "none")).toBe("confirm_withdraw");
    expect(offerChangeStep("on_by_default", "available")).toBe("confirm_available");
  });

  it("does nothing when the choice does not change", () => {
    for (const choice of ["none", "available", "on_by_default"] as const) {
      expect(offerChangeStep(choice, choice)).toBe("none");
    }
  });
});

describe("the confirmations' wording", () => {
  it("states plainly that spaces stop and their schedules are disabled when withdrawing", () => {
    expect(settingsFr["catalogue.orgOffer.withdrawConfirm"]).toContain("planifications");
    expect(settingsFr["catalogue.orgOffer.withdrawConfirm"]).toContain("s'arrêtera");
  });

  it("says that spaces which did not activate it themselves lose it when going to available", () => {
    expect(settingsFr["catalogue.orgOffer.availableTitle"]).toBe("Passer en disponible ?");
    expect(settingsFr["catalogue.orgOffer.availableConfirm"]).toBe(
      "Les espaces qui ne l'ont pas activé eux-mêmes le perdront jusqu'à ce qu'ils l'activent.",
    );
  });
});

describe("setOrgOffer", () => {
  afterEach(() => mock.restore());
  const ok = { response: new Response(null, { status: 200 }) } as never;

  it("offers with PUT …/org-offer, sending the mode", async () => {
    for (const mode of ["available", "on_by_default"] as const) {
      const put = spyOn(client, "PUT").mockResolvedValue(ok);
      const del = spyOn(client, "DELETE").mockResolvedValue(ok);
      await setOrgOffer("@acme/notes", mode);
      expect(put).toHaveBeenCalledWith("/api/packages/{scope}/{name}/org-offer", {
        params: { path: { scope: "@acme", name: "notes" } },
        body: { mode },
      });
      expect(del).not.toHaveBeenCalled();
      mock.restore();
    }
  });

  it("answers the warnings of the offer, and none for a withdrawal", async () => {
    const warning = {
      field: "integrations.@acme/slack",
      code: "integration_not_offered" as const,
      message: "m",
      required: true,
    };
    spyOn(client, "PUT").mockResolvedValue({
      data: { warnings: [warning] },
      response: new Response(),
    });
    spyOn(client, "DELETE").mockResolvedValue(ok);
    expect(await setOrgOffer("@acme/agent", "available")).toEqual([warning]);
    expect(await setOrgOffer("@acme/agent", null)).toEqual([]);
  });

  it("withdraws with DELETE …/org-offer", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue(ok);
    const del = spyOn(client, "DELETE").mockResolvedValue(ok);
    await setOrgOffer("@acme/notes", null);
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
        org_offer: "on_by_default",
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
        org_offer: "on_by_default",
        placements: [
          { space_id: "spc_a", via: "home", state: "active", shared_by: null },
          { space_id: "spc_b", via: "shared", state: "inactive", shared_by: null },
        ],
      }),
    );
    expect(html).not.toContain(settingsFr["catalogue.sheet.viaOrganization"]);
    expect(html).toContain(settingsFr["catalogue.filter.inactive"]);
  });

  it("labels a space where an available offer awaits as available", () => {
    const html = sheet(
      pkg({
        org_offer: "available",
        placements: [
          { space_id: "spc_a", via: "home", state: "active", shared_by: null },
          { space_id: "spc_b", via: "organization", state: "none", shared_by: null },
        ],
      }),
    );
    expect(html).toContain(settingsFr["catalogue.sheet.availableOrganization"]);
    expect(html).not.toContain(settingsFr["catalogue.sheet.viaOrganization"]);
  });
});
