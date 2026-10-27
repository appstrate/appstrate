// SPDX-License-Identifier: Apache-2.0

import { asRecord } from "@appstrate/core/safe-json";
import { AGENT_UI_META_KEY } from "@appstrate/core/validation";

/**
 * The manifest patch (`updateManifest`'s shallow merge) that writes what the
 * appearance picker changed: the manifest `icon`, and the `color` under
 * `_meta[AGENT_UI_META_KEY]`. `null` removes the field — `undefined` clears a
 * key through the merge — and prunes the `_meta` objects it leaves empty;
 * `neutral` is a colour, written like any other. Only the fields that changed
 * are in the patch.
 */
export function agentAppearancePatch(
  manifest: Record<string, unknown>,
  next: { icon?: string | null; color?: string | null },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (next.icon !== undefined) patch.icon = next.icon ?? undefined;

  if (next.color !== undefined) {
    const meta = { ...asRecord(manifest._meta) };
    const ui = { ...asRecord(meta[AGENT_UI_META_KEY]) };

    if (next.color === null) delete ui.color;
    else ui.color = next.color;

    if (Object.keys(ui).length > 0) meta[AGENT_UI_META_KEY] = ui;
    else delete meta[AGENT_UI_META_KEY];

    patch._meta = Object.keys(meta).length > 0 ? meta : undefined;
  }

  return patch;
}
