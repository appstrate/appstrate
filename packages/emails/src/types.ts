// SPDX-License-Identifier: Apache-2.0

import type { OrgRole as CoreOrgRole } from "@appstrate/core/permissions";

export type SupportedLocale = "fr" | "en";

/**
 * Organization role. Mirrors the `org_role` enum in @appstrate/db —
 * kept local so this package stays dependency-free at the value level.
 * The compile-time parity assertion below guarantees this literal stays
 * in sync with the canonical `OrgRole` from `@appstrate/core/permissions`.
 */
export type OrgRole = "owner" | "admin" | "member" | "viewer";

// Compile-time parity check — fails to compile if either side drifts.
type _OrgRoleParity = [CoreOrgRole] extends [OrgRole]
  ? [OrgRole] extends [CoreOrgRole]
    ? true
    : never
  : never;
const _orgRoleParity: _OrgRoleParity = true;
void _orgRoleParity;

export type EmailType = "verification" | "invitation" | "magic-link" | "reset-password";

export interface EmailPropsMap {
  verification: {
    user: { name: string; email: string };
    url: string;
    locale: SupportedLocale;
  };
  invitation: {
    email: string;
    inviteUrl: string;
    orgName: string;
    inviterName: string;
    role: OrgRole;
    locale: SupportedLocale;
  };
  "magic-link": {
    email: string;
    url: string;
    locale: SupportedLocale;
  };
  "reset-password": {
    email: string;
    url: string;
    locale: SupportedLocale;
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export type EmailRenderer<T extends EmailType> = (props: EmailPropsMap[T]) => RenderedEmail;
