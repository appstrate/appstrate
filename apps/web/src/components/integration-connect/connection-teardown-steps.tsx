// SPDX-License-Identifier: Apache-2.0

/** Mount only while the confirmation is open: the endpoint decrypts. */

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
    // `min-w-0`: a grid item's automatic min width is its content's; a long shell line would widen the dialog.
    <div className="mt-4 min-w-0">
      <HandoffSteps steps={data} />
    </div>
  );
}
