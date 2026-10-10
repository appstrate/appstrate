// SPDX-License-Identifier: Apache-2.0

import { VIEW_AS_ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";

/**
 * What a role's own row asks the preview dialog to start from, carried in the
 * address (`?view-as=org:member`, `?view-as=space:viewer`) so the dialog opened
 * from a row keeps a URL that reopens it pre-filled.
 */
export type ViewAsPreset = { kind: "org"; role: ViewAsOrgRole } | { kind: "space"; key: string };

export function viewAsPresetParam(preset: ViewAsPreset): string {
  return preset.kind === "org" ? `org:${preset.role}` : `space:${preset.key}`;
}

/** `null` for the bare `?view-as` of the page's Actions menu, and for anything unreadable. */
export function parseViewAsPreset(raw: string | null): ViewAsPreset | null {
  if (!raw) return null;
  const separator = raw.indexOf(":");
  const kind = raw.slice(0, separator);
  const key = raw.slice(separator + 1);
  if (separator === -1 || !key) return null;
  if (kind === "space") return { kind, key };
  const role = VIEW_AS_ORG_ROLES.find((r) => r === key);
  return kind === "org" && role ? { kind, role } : null;
}
