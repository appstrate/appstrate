/**
 * Shared type definitions for @appstrate/cloud.
 *
 * Cloud doesn't depend on @appstrate/shared-types or @appstrate/db, so
 * these types mirror the corresponding definitions in the main platform.
 */

/**
 * Organization role. Re-exported from core rather than mirrored: core owns the
 * `ORG_ROLES` tuple that drives both the `OrgRole` union and the `org_role` pg
 * enum, and a hand-written copy here is what let cloud keep granting
 * `billing:read` to a `viewer` role the platform had already retired.
 */
export type { OrgRole } from "@appstrate/core/permissions";
