// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

/**
 * A link to the caller's own model providers (Preferences › Mes fournisseurs).
 * It carries the router state along, so from inside the settings overlay the
 * Preferences open over the same screen instead of turning into a full page.
 */
export function PreferencesModelsLink({ children }: { children: ReactNode }) {
  const { state } = useLocation();
  return (
    <Link to="/preferences/models" state={state} className="underline underline-offset-2">
      {children}
    </Link>
  );
}
