// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTML shell for OIDC module emails. Module-owned (not routed
 * through `@appstrate/emails`'s typed registry) because the OIDC end-user
 * templates are keyed on new names the core `EmailType` union doesn't
 * know about. Keeping the shell here preserves the "module touches no
 * core code" rule from Phase 1.
 *
 * Branding is optional: every caller is expected to inject a
 * `ResolvedAppBranding` (from `services/branding.ts`) so the shell
 * renders with the satellite app's name, logo, and accent color. Falls
 * back to the platform default if omitted.
 */

import { escapeHtml } from "../pages/html.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface EmailShellProps {
  title: string;
  preheader?: string;
  bodyHtml: string;
  branding?: ResolvedAppBranding;
}

const DEFAULT_PRIMARY = "#4f46e5";

/**
 * Wrap a rendered body in a minimal, mobile-friendly HTML shell. The
 * `bodyHtml` is treated as trusted (produced by the module's own template
 * code); `title`, `preheader`, and every branding field are escaped.
 */
export function renderEmailShell(props: EmailShellProps): string {
  const brand = props.branding;
  const brandName = brand ? escapeHtml(brand.name) : null;
  const brandLogo = brand?.logoUrl ? escapeHtml(brand.logoUrl) : null;
  const primary = brand?.primaryColor ?? DEFAULT_PRIMARY;
  const safePrimary = /^#[0-9a-fA-F]{6}$/.test(primary) ? primary : DEFAULT_PRIMARY;

  const header = brand
    ? `<tr><td style="padding:0 0 20px;text-align:center;border-bottom:4px solid ${safePrimary};margin-bottom:24px;">
          ${
            brandLogo
              ? `<img src="${brandLogo}" alt="${brandName}" style="max-height:40px;max-width:200px;display:block;margin:0 auto 8px;" />`
              : ""
          }
          <div style="font-size:14px;font-weight:600;color:#111;letter-spacing:0.02em;">${brandName}</div>
        </td></tr>`
    : "";

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(props.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;">
    ${
      props.preheader
        ? `<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(
            props.preheader,
          )}</span>`
        : ""
    }
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            ${header}
            <tr>
              <td>
                ${props.bodyHtml}
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
 * Helper for templates that want the primary button color from branding
 * with a sanitized fallback — protects against injection via unvalidated
 * hex strings.
 */
export function primaryButtonColor(branding?: ResolvedAppBranding): string {
  const c = branding?.primaryColor ?? DEFAULT_PRIMARY;
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT_PRIMARY;
}
