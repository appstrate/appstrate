// SPDX-License-Identifier: Apache-2.0

/**
 * The caller's own personal space: a personal space is reached by its owner alone, so
 * `personal && access === "member"` IS "mine" (the owner's id is absent from the wire, RBAC spec
 * §3.6). The one predicate every "my space" decision reads.
 */
export function isOwnPersonalSpace(space: {
  personal: boolean;
  access: "member" | "none";
}): boolean {
  return space.personal && space.access === "member";
}
