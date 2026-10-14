// SPDX-License-Identifier: Apache-2.0

import type { To } from "react-router-dom";

/**
 * Where a clickable summary leads: a route (`to`, a real link the reader can
 * open in a new tab) or an in-place deed (`onClick`, a button). Never both.
 */
export type ActionTarget = { to: To; onClick?: never } | { to?: never; onClick: () => void };
