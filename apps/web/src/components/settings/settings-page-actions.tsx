// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageActionsMenu } from "../page-actions-menu";
import type { MenuAction } from "../menu-action";

const SettingsPageActionTargetContext = createContext<HTMLElement | null | undefined>(undefined);

export function SettingsPageActionTargetProvider({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <SettingsPageActionTargetContext.Provider value={target}>
      {children}
    </SettingsPageActionTargetContext.Provider>
  );
}

/**
 * Places a settings page's real actions beside the title owned by the shared
 * settings shell, so page content never imitates a header it does not own:
 * the Actions menu of `actions` (nothing when none is left to offer), then any
 * `children`. Outside the shell they render in place.
 */
export function SettingsPageActions({
  actions,
  children,
}: {
  actions?: MenuAction[];
  children?: ReactNode;
}) {
  const target = useContext(SettingsPageActionTargetContext);
  const content = (
    <>
      <PageActionsMenu actions={actions} />
      {children}
    </>
  );
  if (target === undefined) return content;
  return target && createPortal(content, target);
}
