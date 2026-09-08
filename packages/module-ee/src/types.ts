// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Platform types this module reads, re-exported from `@appstrate/core` — the
 * one package it depends on for them. Nothing here is a hand-written copy: core
 * owns the `ORG_ROLES` tuple that drives both the `OrgRole` union and the
 * `org_role` pg enum, and a copy is what let this module keep granting
 * `billing:read` to a role the platform had already retired.
 */

/**
 * Organization role. Re-exported from core rather than mirrored: core owns the
 * `ORG_ROLES` tuple that drives both the `OrgRole` union and the `org_role` pg
 * enum, and a hand-written copy here is what let EE keep granting
 * `billing:read` to a `viewer` role the platform had already retired.
 */
export type { OrgRole } from "@appstrate/core/permissions";
