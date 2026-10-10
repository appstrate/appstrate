// SPDX-License-Identifier: Apache-2.0

import { parseEgressAllowInternalHosts } from "@appstrate/afps-shared/ssrf";

/** The `EGRESS_ALLOW_INTERNAL_HOSTS` fixture list of test/setup/preload.ts, parsed as at boot. */
export const TEST_EGRESS_ALLOW_INTERNAL_HOSTS: ReadonlySet<string> = parseEgressAllowInternalHosts(
  process.env.EGRESS_ALLOW_INTERNAL_HOSTS,
).hosts;
