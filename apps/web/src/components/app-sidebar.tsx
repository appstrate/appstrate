// SPDX-License-Identifier: Apache-2.0

import { NavOrg } from "@/components/nav-org";
import { ShellSidebar } from "@/components/shell-frame";

/** Studio's sidebar: the shell frame, filled with Studio's navigation. */
export function AppSidebar() {
  return (
    <ShellSidebar>
      <NavOrg />
    </ShellSidebar>
  );
}
