// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { SupportedLocale } from "./types.ts";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface LayoutProps {
  locale: SupportedLocale;
  content: string;
  footer?: string;
  /** Organization the email concerns — rendered as a muted header line. */
  orgName?: string | null;
}

const orgLabels: Record<SupportedLocale, string> = {
  fr: "Organisation\u00a0:",
  en: "Organization:",
};

/**
 * Appstrate Cloud-branded email layout — Appstrate logo, light theme with transparent background.
 * Works in both light and dark mode email clients.
 */
export function wrapEeLayout({ locale, content, footer, orgName }: LayoutProps): string {
  const trimmedOrgName = orgName?.trim();
  const orgLine = trimmedOrgName
    ? `<p style="margin:0 0 16px;font-size:13px;color:#737373;">${orgLabels[locale] ?? orgLabels.fr} <strong style="color:#525252;">${escapeHtml(trimmedOrgName)}</strong></p>
              `
    : "";
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title></title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <!-- Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;border:1px solid #e5e5e5;overflow:hidden;">
          <tr>
            <td style="padding:32px 40px;color:#1a1a1a;font-size:15px;line-height:1.6;">
              ${orgLine}${content}
            </td>
          </tr>
          ${
            footer
              ? `<tr>
            <td style="padding:0 40px 32px;color:#737373;font-size:13px;line-height:1.5;">
              ${footer}
            </td>
          </tr>`
              : ""
          }
        </table>
        <!-- Footer links -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr>
            <td style="padding:24px 0 0;text-align:center;color:#a3a3a3;font-size:12px;">
              <a href="https://appstrate.com" style="color:#a3a3a3;text-decoration:none;">appstrate.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Format an ISO date string into a localized human-readable date.
 * Single source of truth for date formatting across all billing email templates.
 */
export function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale === "fr" ? "fr-FR" : "en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td style="background-color:#6d28d9;border-radius:8px;padding:14px 28px;">
      <a href="${url}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;display:inline-block;">${label}</a>
    </td>
  </tr>
</table>`;
}
