// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone error page for OIDC flows.
 *
 * Used when no client context is available (missing or invalid client_id,
 * disabled client). Falls back to platform default branding so the user
 * always sees a styled page — never raw JSON in their browser.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import { PLATFORM_DEFAULT_BRANDING, type ResolvedAppBranding } from "../services/branding.ts";

export interface ErrorPageProps {
  /** Error title — e.g. "Application introuvable". */
  title: string;
  /** Descriptive message explaining what happened. */
  message: string;
  /** Optional branding — falls back to platform defaults. */
  branding?: ResolvedAppBranding;
}

export function renderErrorPage(props: ErrorPageProps): RawHtml {
  const branding = props.branding ?? PLATFORM_DEFAULT_BRANDING;
  const bodyHtml = html`
    <h1>${props.title}</h1>
    <p>${props.message}</p>
  `;
  return renderLayout({ branding, title: props.title, maxWidth: 440, bodyHtml });
}
