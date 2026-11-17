// SPDX-License-Identifier: Apache-2.0

/** The decisions of the organization/space switcher (`components/org-switcher.tsx`), apart from its markup. */

/**
 * The panel's shape: a phone presents it under the trigger, and one organization has nothing
 * to explore, so its row heads the spaces in one column, as on a phone.
 */
export function switcherShape(input: {
  variant: "brand" | "mobile";
  isMobile: boolean;
  orgCount: number;
}): { mobilePresentation: boolean; stacked: boolean } {
  const mobilePresentation = input.variant === "mobile" || input.isMobile;
  return { mobilePresentation, stacked: mobilePresentation || input.orgCount === 1 };
}

/**
 * How a row's settings (or « Nouvel espace ») open: as a plain link when they are the current
 * context's; after entering the space when it is another of the current organization (the page
 * stays beneath); after switching organization otherwise (the page beneath moves to its
 * landing, `useOpenOverlayAfterOrgSwitch`).
 */
export function settingsEntry(
  current: { orgId: string; spaceId: string | null },
  target: { orgId: string; spaceId?: string },
): "link" | "space" | "organization" {
  if (target.orgId !== current.orgId) return "organization";
  if (target.spaceId === undefined || target.spaceId === current.spaceId) return "link";
  return "space";
}

/** Whether the reader may create a space in an organization: `spaces:write`, an organization-level permission the org listing carries. */
export function mayCreateSpaceIn(
  orgs: readonly { id: string; permissions: readonly string[] }[],
  orgId: string | null,
): boolean {
  return !!orgs.find((org) => org.id === orgId)?.permissions.includes("spaces:write");
}
