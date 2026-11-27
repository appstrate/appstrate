// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { availabilityLabel } from "../package-availability";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const base = { shared_by: null } as const;

describe("availabilityLabel", () => {
  it("names the provenance of an active placement", () => {
    expect(availabilityLabel({ ...base, via: "home", state: "active" }, "agent").key).toBe(
      "packages.availability.home",
    );
    expect(availabilityLabel({ ...base, via: "system", state: "active" }, "skill").key).toBe(
      "packages.availability.system",
    );
    expect(availabilityLabel({ ...base, via: "organization", state: "active" }, "agent").key).toBe(
      "packages.availability.organization",
    );
  });

  it("names the sharer of a shared placement, or says « partagé » without one", () => {
    expect(
      availabilityLabel(
        { via: "shared", state: "active", shared_by: { user_id: "u", name: "Ada" } },
        "agent",
      ),
    ).toEqual({ key: "packages.availability.sharedBy", params: { name: "Ada" } });
    expect(availabilityLabel({ ...base, via: "shared", state: "active" }, "skill")).toEqual({
      key: "packages.availability.shared",
      params: {},
    });
  });

  it("says an offer through the organization with no row of its own is available to switch on", () => {
    expect(availabilityLabel({ ...base, via: "organization", state: "none" }, "agent")).toEqual({
      key: "packages.availability.available",
      params: {},
    });
    expect(
      availabilityLabel({ ...base, via: "organization", state: "none" }, "integration").key,
    ).toBe("packages.availability.available_integration");
  });

  it("keeps the provenance of an inactive placement", () => {
    for (const via of ["home", "system", "organization"] as const) {
      expect(availabilityLabel({ ...base, via, state: "inactive" }, "agent")).toEqual({
        key: `packages.availability.off.${via}`,
        params: {},
      });
    }
    expect(
      availabilityLabel(
        { via: "shared", state: "inactive", shared_by: { user_id: "u", name: "Ada" } },
        "skill",
      ),
    ).toEqual({ key: "packages.availability.off.sharedBy", params: { name: "Ada" } });
    expect(availabilityLabel({ ...base, via: "shared", state: "inactive" }, "agent").key).toBe(
      "packages.availability.off.shared",
    );
  });

  it("reads a placement without a row as not activated, provenance kept", () => {
    expect(availabilityLabel({ ...base, via: "home", state: "none" }, "agent")).toEqual({
      key: "packages.availability.off.home",
      params: {},
    });
    expect(availabilityLabel({ ...base, via: "system", state: "none" }, "skill").key).toBe(
      "packages.availability.off.system",
    );
  });

  it("names the feminine variant for an integration", () => {
    expect(availabilityLabel({ ...base, via: "home", state: "active" }, "integration")).toEqual({
      key: "packages.availability.home_integration",
      params: {},
    });
    expect(
      availabilityLabel(
        { via: "shared", state: "inactive", shared_by: { user_id: "u", name: "Ada" } },
        "integration",
      ),
    ).toEqual({
      key: "packages.availability.off.sharedBy_integration",
      params: { name: "Ada" },
    });
  });

  it("resolves to a French sentence that agrees with the package's gender", async () => {
    const i18nModule = await import("../../i18n.ts");
    await i18nModule.i18nReady;
    const t = i18nModule.default.getFixedT("fr", "settings");
    const label = (type: "agent" | "integration") => {
      const { key, params } = availabilityLabel({ ...base, via: "home", state: "active" }, type);
      return t(key, params);
    };
    expect(label("agent")).toBe("Activé · espace d’origine");
    expect(label("integration")).toBe("Activée · espace d’origine");
  });
});
