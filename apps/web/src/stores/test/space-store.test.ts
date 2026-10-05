// SPDX-License-Identifier: Apache-2.0

/**
 * The last space of each account in each organization is remembered across an
 * organization switch and a sign-out; both only clear the SCOPE (`id`), which
 * is what rides in `X-Space-Id`.
 */

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

const storage = installFakeStorage();

const { authStore } = await import("../auth-store.ts");
const { orgStore } = await import("../org-store.ts");
const { rememberedSpaceKey, spaceStore } = await import("../space-store.ts");

const KEY = "appstrate_last_space_by_org";
const persisted = () => JSON.parse(storage.getItem(KEY) ?? "{}");
const signIn = (id: string) =>
  authStore.setState({ user: { id, email: `${id}@test.com`, emailVerified: true } });

describe("space store", () => {
  // Another suite of the same process may have imported the stores first.
  const before = {
    auth: authStore.getState(),
    org: orgStore.getState().id,
    space: spaceStore.getState(),
  };
  beforeAll(() => {
    storage.setItem(KEY, JSON.stringify({ "usr_a:org_a": "spc_studio" }));
    spaceStore.setState({ id: null, remembered: { "usr_a:org_a": "spc_studio" } });
    signIn("usr_a");
  });
  afterAll(() => {
    authStore.setState(before.auth);
    orgStore.setState({ id: before.org });
    spaceStore.setState(before.space);
  });

  it("remembers the space under the account and the organization it was chosen in", () => {
    orgStore.getState().setId("org_b");
    spaceStore.getState().setId("spc_beta");
    expect(spaceStore.getState().id).toBe("spc_beta");
    expect(persisted()).toEqual({ "usr_a:org_a": "spc_studio", "usr_a:org_b": "spc_beta" });
  });

  it("drops the scope on an organization switch, and forgets nothing", () => {
    // `selectOrg` ends on `setId(null)`; sign-out is `lib/test/clear-session.test.ts`.
    orgStore.getState().setId("org_a");
    spaceStore.getState().setId(null);
    expect(spaceStore.getState().id).toBeNull();
    expect(persisted()).toEqual({ "usr_a:org_a": "spc_studio", "usr_a:org_b": "spc_beta" });
    expect(spaceStore.getState().remembered).toEqual(persisted());
  });

  it("keeps each account's choice apart in the same organization", () => {
    // B signs in on A's browser: nothing is remembered for B in org_a, and what
    // B chooses does not replace what A will come back to.
    signIn("usr_b");
    orgStore.getState().setId("org_a");
    const remembered = spaceStore.getState().remembered;
    expect(remembered[rememberedSpaceKey("usr_b", "org_a")]).toBeUndefined();

    spaceStore.getState().setId("spc_default");
    expect(persisted()).toEqual({
      "usr_a:org_a": "spc_studio",
      "usr_a:org_b": "spc_beta",
      "usr_b:org_a": "spc_default",
    });
    signIn("usr_a");
  });

  it("keeps what another tab remembered since this one loaded", () => {
    storage.setItem(KEY, JSON.stringify({ ...persisted(), "usr_a:org_c": "spc_other_tab" }));
    orgStore.getState().setId("org_a");
    spaceStore.getState().setId("spc_vitrine");
    expect(persisted()).toMatchObject({
      "usr_a:org_a": "spc_vitrine",
      "usr_a:org_c": "spc_other_tab",
    });
    expect(spaceStore.getState().remembered).toEqual(persisted());
  });

  it("ignores a stored value that is not a map of ids", () => {
    storage.setItem(KEY, JSON.stringify(["spc_x", { org_z: 3 }]));
    orgStore.getState().setId("org_a");
    spaceStore.getState().setId("spc_studio");
    expect(persisted()).toEqual({ "usr_a:org_a": "spc_studio" });
  });
});
