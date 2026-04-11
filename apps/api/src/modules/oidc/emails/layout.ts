// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTML shell for OIDC module emails. Module-owned (not routed
 * through `@appstrate/emails`'s typed registry) because the OIDC end-user
 * templates are keyed on new names the core `EmailType` union doesn't
 * know about. Keeping the shell here preserves the "module touches no
 * core code" rule from Phase 1.
 */

import { escapeHtml } from "../pages/html.ts";

export interface EmailShellProps {
  title: string;
  preheader?: string;
  bodyHtml: string;
}

/**
 * Wrap a rendered body in a minimal, mobile-friendly HTML shell. The
 * `bodyHtml` is treated as trusted (produced by the module's own template
 * code); `title` and `preheader` are escaped.
 */
export function renderEmailShell(props: EmailShellProps): string {
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
