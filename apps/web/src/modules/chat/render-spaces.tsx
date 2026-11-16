// SPDX-License-Identifier: Apache-2.0

import type { RenderSpaces } from "@appstrate/module-chat/ui";
import { SpaceTilesOf } from "../../components/space-name";

/**
 * The chat's seam to name spaces: the app's own tile and name per space, none counted away (a
 * type-only import of the module: the entry chunk stays free of it). Several spaces stack their
 * tiles, ringed in the sidebar's colour: the conversation list is where a row names several.
 */
export const renderSpaces: RenderSpaces = (spaceIds) => (
  <SpaceTilesOf spaceIds={spaceIds} ringClassName="ring-sidebar" />
);
