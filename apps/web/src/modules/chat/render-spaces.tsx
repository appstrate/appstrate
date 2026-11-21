// SPDX-License-Identifier: Apache-2.0

import type { RenderSpaces } from "@appstrate/module-chat/ui";
import { SpaceTilesOf } from "../../components/space-name";

/**
 * The chat's seam to name spaces: {@link SpaceTilesOf}, none counted away. Several spaces stack
 * their tiles, ringed in `--tile-ring`, the colour a conversation row sets for its current
 * state (rest, hover, active). A file of its own: a component file exports components only (fast
 * refresh).
 */
export const renderSpaces: RenderSpaces = (spaceIds) => <SpaceTilesOf spaceIds={spaceIds} />;
