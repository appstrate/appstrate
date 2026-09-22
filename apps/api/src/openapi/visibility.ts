// SPDX-License-Identifier: Apache-2.0

import { VISIBILITY_META_NAMESPACE } from "../lib/package-helpers.ts";

/** The `unlisted` marker as the spec spells it, built from the one namespace constant. */
export const UNLISTED_MARKER = `\`_meta["${VISIBILITY_META_NAMESPACE}"].level = "unlisted"\``;

/** Appended to the description of every catalogue listing that `listedFilter` narrows. */
export const UNLISTED_OFF_CATALOGUE = ` Unlisted packages (${UNLISTED_MARKER}) are not on it and stay reachable by exact id.`;
