// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** A link to the caller's own keys (Preferences › Mes clés). */
export function PreferencesModelsLink({ children }: { children: ReactNode }) {
  return (
    <Link to="/preferences/models" className="underline underline-offset-2">
      {children}
    </Link>
  );
}
