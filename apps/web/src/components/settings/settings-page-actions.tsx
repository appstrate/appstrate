// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
 * settings shell, so page content never imitates a header it does not own.
 * Outside the shell they render in place.
 */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const target = useContext(SettingsPageActionTargetContext);
  if (target === undefined) return children;
  return target && createPortal(children, target);
}
