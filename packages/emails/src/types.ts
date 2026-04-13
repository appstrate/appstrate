// SPDX-License-Identifier: Apache-2.0

export type SupportedLocale = "fr" | "en";

/**
 * Organization role. Mirrors the `org_role` enum in @appstrate/db —
 * kept local so this package stays dependency-free.
 */
export type OrgRole = "owner" | "admin" | "member" | "viewer";

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
