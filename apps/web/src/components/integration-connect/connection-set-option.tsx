// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { connectionOptionLabel } from "../../lib/connection-set";
import type { IntegrationConnection } from "../../hooks/use-integrations";
import { ConnectionVariablesLine } from "./connection-variables-line";

/** One connection of a plain list, as the connection choice menu lists it. */
export interface SetOption {
  id: string;
  /** What the trigger reads when it is the one connection chosen. */
  name: string;
  description?: ReactNode;
  /** Refuses a tick; a ticked one can still be unticked. */
  disabled?: boolean;
}

/** A connection of an org-wide list as a row: owner and variables tell same-named ones apart. */
export function connectionSetOption(c: IntegrationConnection): SetOption {
  return {
    id: c.id,
    name: connectionOptionLabel(c),
    description: c.variables ? <ConnectionVariablesLine variables={c.variables} /> : undefined,
  };
}
