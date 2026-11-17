// SPDX-License-Identifier: Apache-2.0

import type { SpaceChoiceMenu } from "@appstrate/module-chat/ui";
import { SpaceChoiceDropdown, SpaceChoiceSubmenu } from "../../components/space-choice-menu";
import { useSpacesOf } from "../../hooks/use-spaces";

export const ChatSpaceChoiceMenu: SpaceChoiceMenu = ({
  variant,
  label,
  spaceIds,
  onPick,
  trigger,
  testId,
}) => {
  const spaces = useSpacesOf(spaceIds);
  const choice = { label, spaces, onPick };
  return variant === "dropdown" ? (
    <SpaceChoiceDropdown choice={choice}>{trigger}</SpaceChoiceDropdown>
  ) : (
    <SpaceChoiceSubmenu
      choice={choice}
      trigger={trigger}
      marks={testId ? { "data-testid": testId } : undefined}
    />
  );
};
