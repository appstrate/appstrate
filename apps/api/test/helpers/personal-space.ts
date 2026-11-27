// SPDX-License-Identifier: Apache-2.0

/**
 * What the personal-space role suites share: the caller's own space as `GET /api/spaces` lists
 * it, and the delete floor every role short of `admin` carries there.
 */

import { expect } from "bun:test";
import { PERSONAL_CAP_DELETE_PERMISSIONS } from "../../src/lib/space-role.ts";
import { getTestApp } from "./app.ts";
import { orgOnlyHeaders, type TestContext } from "./auth.ts";

export interface ListedSpace {
  id: string;
  personal: boolean;
  role: { kind: string; key: string; name: string } | null;
  permissions: string[];
  shows_studio: boolean;
}

/** The four delete permissions an owner holds on top of a role short of `admin`. */
export const DELETES: readonly string[] = PERSONAL_CAP_DELETE_PERMISSIONS;

/** The caller's own personal space as `GET /api/spaces` lists (and provisions) it. */
export async function personalOf(ctx: TestContext): Promise<ListedSpace> {
  const res = await getTestApp().request("/api/spaces", { headers: orgOnlyHeaders(ctx) });
  expect(res.status, await res.clone().text()).toBe(200);
  const own = ((await res.json()) as { data: ListedSpace[] }).data.filter((s) => s.personal);
  expect(own).toHaveLength(1);
  return own[0]!;
}
