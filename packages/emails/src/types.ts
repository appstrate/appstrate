// SPDX-License-Identifier: Apache-2.0

export type SupportedLocale = "fr" | "en";

export type EmailType =
  | "verification"
  | "invitation"
  | "magic-link"
  | "reset-password"
  | "enduser-verification"
  | "enduser-reset-password"
  | "enduser-welcome";

export interface AppBranding {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  supportEmail?: string;
  fromName?: string;
}

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
    role: string;
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
  "enduser-verification": {
    user: { name: string; email: string };
    url: string;
    branding: AppBranding;
    locale: SupportedLocale;
  };
  "enduser-reset-password": {
    email: string;
    url: string;
    branding: AppBranding;
    locale: SupportedLocale;
  };
  "enduser-welcome": {
    user: { name: string; email: string };
    branding: AppBranding;
    locale: SupportedLocale;
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export type EmailRenderer<T extends EmailType> = (props: EmailPropsMap[T]) => RenderedEmail;
