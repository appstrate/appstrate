// SPDX-License-Identifier: Apache-2.0

import { useChatHost } from "./runtime-context.ts";

/** The space a tool call acted in (`callSpaceOf`, the one stamped on it), named by the host. */
export function CallSpace({ spaceId }: { spaceId: string | undefined }) {
  const { renderSpaces } = useChatHost();
  if (!spaceId) return null;
  return (
    <span className="text-muted-foreground flex max-w-40 min-w-0 shrink-0 items-center text-xs">
      {renderSpaces([spaceId])}
    </span>
  );
}
