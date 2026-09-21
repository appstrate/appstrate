// SPDX-License-Identifier: Apache-2.0

/**
 * What deleting a connection leaves behind on a target host, rendered inside
 * the confirmation that deletes it. The endpoint returns only the steps due AT
 * deletion, and an empty list for a credential the user pasted — the common
 * case, which renders nothing.
 *
 * Every surface that deletes a connection mounts this, so the block cannot be
 * on one of them and missing from the other.
 *
 * Mount it only while the confirmation is open: the endpoint decrypts, so a
 * list of rows must not pay for the one row being acted on.
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
