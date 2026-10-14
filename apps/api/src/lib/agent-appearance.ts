// SPDX-License-Identifier: Apache-2.0

import { asRecord } from "@appstrate/core/safe-json";
import { AGENT_UI_META_KEY } from "@appstrate/core/validation";

/**
 * Portable Agent identity used by Appstrate surfaces.
 *
 * The icon is the standard AFPS manifest field. The color is presentation
 * metadata, so it stays namespaced under `_meta` instead of becoming an Agent
 * runtime concern.
 */
export function readAgentAppearance(manifest: Record<string, unknown>): {
  icon?: string;
  color?: string;
} {
  const icon = typeof manifest.icon === "string" ? manifest.icon : undefined;
  const meta = asRecord(manifest._meta);
  const ui = asRecord(meta[AGENT_UI_META_KEY]);
  const color = typeof ui.color === "string" ? ui.color : undefined;

  return {
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
  };
}
