// SPDX-License-Identifier: Apache-2.0

import type { ReachableSpaceGrant } from "@appstrate/core/module";

/**
 * A reached space with every field the platform answers: an ordinary team space
 * (not the default, not personal, direct access closed) unless `over` says otherwise.
 */
export function reachableSpace(over: Partial<ReachableSpaceGrant> = {}): ReachableSpaceGrant {
  return {
    id: "spc_test",
    name: "Test",
    role: "member",
    permissions: [],
    credentialProxyOpen: false,
    isDefault: false,
    personal: false,
    ...over,
  };
}
