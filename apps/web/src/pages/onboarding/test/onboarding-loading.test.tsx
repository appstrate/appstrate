// SPDX-License-Identifier: Apache-2.0

/**
 * The onboarding recap and model step draw nothing from a default while their
 * reads are on their way: no « Aucun modèle configuré », no button label picked
 * from an unknown list, and the billing plan's card holds its slot.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { components } from "../../../api/client.ts";

installFakeStorage({
  __APP_CONFIG__: { features: { billing: true }, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});

// The layout pulls in the theme store (paints `<html>` at import) and sonner (injects a
// `<style>` at import): a stub keeps both inert.
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: { classList: { add() {}, remove() {} } },
    head: { appendChild() {} },
    createElement: () => ({ appendChild() {} }),
    createTextNode: () => ({}),
  },
});
afterAll(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete (globalThis as { document?: unknown }).document;
});

const { OnboardingDoneStep } = await import("../done-step.tsx");
const { OnboardingModelStep } = await import("../model-step.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { render } = await import("../../../test/render.tsx");
const i18nModule = await import("../../../i18n.ts");
const settingsFr = (await import("../../../locales/fr/settings.json")).default;
const { authStore } = await import("../../../stores/auth-store.ts");

// Signed out, the session read settled: the state the boot resync leaves without a session.
authStore.setState({ user: null, profile: null, loading: false });

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_onb";

function page(node: React.ReactElement): string {
  const qc = new QueryClient();
  const org: components["schemas"]["Organization"] = {
    id: ORG_ID,
    name: "Onboarding Org",
    slug: "onb",
    icon: null,
    color: null,
    role: "owner",
    deleting_at: null,
    permissions: ["billing:read"],
    createdAt: "2026-09-05T00:00:00Z",
  };
  qc.setQueryData(["orgs"], [org]);
  const spy = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(node, { queryClient: qc });
  } finally {
    spy.mockRestore();
  }
}

describe("onboarding recap while its reads load", () => {
  const html = page(<OnboardingDoneStep />);

  it("does not claim « no model » or « no member » before the lists answer", () => {
    expect(html).not.toContain(settingsFr["onboarding.summaryModelNone"]);
    expect(html).not.toContain(settingsFr["onboarding.summaryMembersNone"]);
    expect(html).toContain("animate-pulse");
  });

  it("holds the plan card's slot while billing loads", () => {
    expect(html).toContain(settingsFr["onboarding.summaryPlan"]);
  });
});

describe("onboarding model step while the models load", () => {
  const html = page(<OnboardingModelStep />);

  it("picks no label for « Ajouter » until the list is known", () => {
    expect(html).not.toContain(settingsFr["models.add"]);
    expect(html).not.toContain(settingsFr["onboarding.modelSeed.addAnother"]);
    expect(html).toContain("animate-pulse");
  });
});
