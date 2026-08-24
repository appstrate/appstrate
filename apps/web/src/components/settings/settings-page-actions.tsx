// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface SettingsPageActionTargets {
  desktop: HTMLElement | null;
  mobile: HTMLElement | null;
}

const SettingsPageActionTargetsContext = createContext<SettingsPageActionTargets | null>(null);

export function SettingsPageActionTargetsProvider({
  targets,
  children,
}: {
  targets: SettingsPageActionTargets;
  children: ReactNode;
}) {
  return (
    <SettingsPageActionTargetsContext.Provider value={targets}>
      {children}
    </SettingsPageActionTargetsContext.Provider>
  );
}

/**
 * Places a settings page's real actions beside the title owned by the shared
 * settings shell. Both destinations stay in the shell so page content never
 * needs spacing tricks to imitate a header it does not own.
 */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const targets = useContext(SettingsPageActionTargetsContext);

  if (!targets) return children;

  return (
    <>
      {targets.desktop && createPortal(children, targets.desktop, "settings-actions-desktop")}
      {targets.mobile && createPortal(children, targets.mobile, "settings-actions-mobile")}
    </>
  );
}
