// SPDX-License-Identifier: Apache-2.0

import type { RenderSpaces } from "@appstrate/module-chat/ui";
import { SpaceNamesOf } from "../../components/space-name";

/** The chat's seam to name spaces: the app's own tile and name, « +2 » for the others (a type-only import of the module: the entry chunk stays free of it). */
export const renderSpaces: RenderSpaces = (spaceIds) => <SpaceNamesOf spaceIds={spaceIds} />;
