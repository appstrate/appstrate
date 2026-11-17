// SPDX-License-Identifier: Apache-2.0

import type { SpaceChoiceSubmenu } from "@appstrate/module-chat/ui";
import { SpaceChoiceSubmenu as AppSpaceChoiceSubmenu } from "../../components/space-choice-menu";
import { useSpacesOf } from "../../hooks/use-spaces";

/**
 * The chat's seam to ask for a space: the app's {@link AppSpaceChoiceSubmenu}, its spaces read
 * from the listing by id. A file of its own: a component file exports components only (fast
 * refresh).
 */
export const ChatSpaceChoiceSubmenu: SpaceChoiceSubmenu = ({
  label,
  spaceIds,
  onPick,
  trigger,
  testId,
}) => {
  const spaces = useSpacesOf(spaceIds);
  return (
    <AppSpaceChoiceSubmenu
      choice={{ label, spaces, onPick }}
      trigger={trigger}
      marks={testId ? { "data-testid": testId } : undefined}
    />
  );
};
