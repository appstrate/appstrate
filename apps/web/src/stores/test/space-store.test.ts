// SPDX-License-Identifier: Apache-2.0

/**
 * The last space of each organization is remembered across an organization
 * switch and a sign-out; both only clear the SCOPE (`id`), which is what rides
 * in `X-Space-Id`.
 */

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

const storage = installFakeStorage();

const { orgStore } = await import("../org-store.ts");
const { spaceStore } = await import("../space-store.ts");

const persisted = () => JSON.parse(storage.getItem("appstrate_last_space_by_org") ?? "{}");

describe("space store", () => {
  // Another suite of the same process may have imported the stores first.
  const before = { org: orgStore.getState().id, space: spaceStore.getState() };
  beforeAll(() => spaceStore.setState({ id: null, remembered: { org_a: "spc_studio" } }));
  afterAll(() => {
    orgStore.setState({ id: before.org });
    spaceStore.setState(before.space);
  });

  it("remembers the space under the organization it was chosen in", () => {
    orgStore.getState().setId("org_b");
    spaceStore.getState().setId("spc_beta");
    expect(spaceStore.getState().id).toBe("spc_beta");
    expect(persisted()).toEqual({ org_a: "spc_studio", org_b: "spc_beta" });
  });

  it("drops the scope on an organization switch or a sign-out, and forgets nothing", () => {
    // `selectOrg` (switch) and `clearSession` (sign-out) both end on `setId(null)`.
    orgStore.getState().setId("org_a");
    spaceStore.getState().setId(null);
    expect(spaceStore.getState().id).toBeNull();

    orgStore.getState().setId(null);
    spaceStore.getState().setId(null);
    expect(spaceStore.getState().remembered).toEqual({ org_a: "spc_studio", org_b: "spc_beta" });
    expect(persisted()).toEqual({ org_a: "spc_studio", org_b: "spc_beta" });
  });
});
