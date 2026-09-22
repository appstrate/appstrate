// SPDX-License-Identifier: Apache-2.0

import { VISIBILITY_META_NAMESPACE } from "../lib/package-helpers.ts";

export const UNLISTED_MARKER = `\`_meta["${VISIBILITY_META_NAMESPACE}"].level = "unlisted"\``;

/** Appended to every listing `listedFilter` narrows. */
export const UNLISTED_OFF_CATALOGUE = ` Unlisted packages (${UNLISTED_MARKER}) are not on it and stay reachable by exact id.`;
