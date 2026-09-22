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
    // `min-w-0`: this is a grid item of the dialog, and a grid item's automatic
    // minimum width is its content's — a long shell line would widen the dialog
    // instead of scrolling inside the copy block.
    <div className="mt-4 min-w-0">
      <HandoffSteps steps={data} />
    </div>
  );
}
