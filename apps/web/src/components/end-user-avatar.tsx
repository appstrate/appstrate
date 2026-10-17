// SPDX-License-Identifier: Apache-2.0

import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import type { EndUserInfo } from "../hooks/use-end-users";

/** An end-user's initials on the identity colour hashed from their id. */
export function EndUserAvatar({ user }: { user: EndUserInfo }) {
  return (
    <IdentityTile
      seed={user.id}
      label={user.name?.trim() || user.email?.trim() || ""}
      shape="round"
      className="size-8"
    />
  );
}
