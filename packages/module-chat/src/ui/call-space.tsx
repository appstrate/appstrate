// SPDX-License-Identifier: Apache-2.0

import { useChatHost } from "./runtime-context.ts";

/**
 * The space a tool call acted in (`callSpaceOf`, the one stamped on it), named by the host. Below
 * `sm` a line has no room for the name: the space's tile stands alone, the name in its title.
 */
export function CallSpace({ spaceId }: { spaceId: string | undefined }) {
  const { renderSpaces } = useChatHost();
  if (!spaceId) return null;
  return (
    <span className="text-muted-foreground flex max-w-40 min-w-0 shrink-0 items-center text-xs">
      <span className="flex min-w-0 items-center max-sm:hidden">{renderSpaces([spaceId])}</span>
      <span className="flex items-center sm:hidden">
        {renderSpaces([spaceId], { tilesOnly: true })}
      </span>
    </span>
  );
}
