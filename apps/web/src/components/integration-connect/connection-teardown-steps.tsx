// SPDX-License-Identifier: Apache-2.0

/**
 * What deleting a connection leaves behind on a target host (nothing for a
 * pasted credential). Mount only while the confirmation is open: the endpoint decrypts.
 */

import { $api } from "../../api/client";
import { HandoffSteps } from "./handoff-steps";

export function ConnectionTeardownSteps({ connectionId }: { connectionId: string }) {
  const { data } = $api.useQuery(
    "get",
    "/api/me/connections/{connectionId}/handoff",
    { params: { path: { connectionId } } },
    { select: (e) => e.data },
  );
  if (!data || data.length === 0) return null;

  return (
    <div className="mt-4">
      <HandoffSteps steps={data} />
    </div>
  );
}
