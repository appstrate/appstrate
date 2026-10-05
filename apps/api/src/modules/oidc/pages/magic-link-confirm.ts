// SPDX-License-Identifier: Apache-2.0

/**
 * Server-rendered confirmation interstitial for magic-link verification.
 *
 * Served at GET/POST /api/oauth/magic-link/confirm. The email embeds a URL
 * pointing here (NOT directly at Better Auth's `/api/auth/magic-link/verify`)
 * so that one-shot token consumption is gated behind an explicit click.
 *
 * Why: email clients and delivery pipelines (Resend click-tracking, Outlook
 * SafeLinks, Gmail preview, Apple Mail Link Preview, corporate URL
 * scanners) routinely prefetch `GET` URLs from emails, which consumes the
 * single-use magic-link token before the actual user click lands. The
 * downstream OAuth flow then fails with `session no longer exists` or a
 * generic `session_expired` on the relying-party callback.
 *
 * SOTA pattern: mirror Slack / Notion / Linear / Supabase (Oct 2023+).
 * The GET renders a static "Confirm sign-in" page — idempotent, safe to
 * prefetch. The POST (user click) forwards the browser to BA's verify
 * endpoint, which consumes the token and establishes the BA session in the
 * user's own browser.
 *
 * CSRF: we issue a one-shot `oidc_csrf` cookie on GET and verify it on POST,
 * matching the rest of the OIDC entry pages. Prefetchers get their own
 * cookie (discarded), the user's fresh GET issues a fresh CSRF paired with
 * what ends up in their browser.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedSpaceBranding } from "../services/branding.ts";
import { BA_MAGIC_LINK_VERIFY_PATH } from "@appstrate/db/auth";
import { logger } from "../../../lib/logger.ts";

const MAGIC_LINK_CONFIRM_PATH = "/api/oauth/magic-link/confirm";

/**
 * Turn Better Auth's verify URL into the URL of this interstitial — the one
 * the email carries. The query (token, callbackURL, errorCallbackURL) is kept
 * as is; the POST handler hands it back to the verify endpoint.
 */
export function toMagicLinkConfirmUrl(verifyUrl: string, email: string): string {
  const url = new URL(verifyUrl);
  if (url.pathname !== BA_MAGIC_LINK_VERIFY_PATH) {
    // A Better Auth upgrade moved the verify route: the email falls back to
    // the direct link, which a mail scanner can burn. Loud, so it is caught
    // in ops before users report expired links.
    logger.warn("oidc: unexpected magic-link verify path, emailing the direct link", {
      module: "oidc",
      pathname: url.pathname,
    });
    return verifyUrl;
  }
  url.pathname = MAGIC_LINK_CONFIRM_PATH;
  // Shown on the interstitial ("you are signing in as …"). The URL only ever
  // reaches that address's inbox.
  url.searchParams.set("email", email);
  return url.toString();
}

interface MagicLinkConfirmPageProps {
  /** Action URL for the POST form — `/api/oauth/magic-link/confirm?token=…&callbackURL=…&errorCallbackURL=…`. */
  action: string;
  csrfToken: string;
  branding: ResolvedSpaceBranding;
  /** User-facing email the link was sent to, if parseable from context. Optional display aid. */
  email?: string;
}

export function renderMagicLinkConfirmPage(props: MagicLinkConfirmPageProps): RawHtml {
  const title = `Confirmer la connexion — ${props.branding.name}`;
  const bodyHtml = html`
    <h1>Confirmer la connexion</h1>
    <p>
      ${
        props.email
          ? html`Vous êtes sur le point de vous connecter en tant que
              <strong>${props.email}</strong>.`
          : html`Vous êtes sur le point de vous connecter à
              <strong>${props.branding.name}</strong>.`
      }
    </p>
    <p class="muted">
      Cliquez sur le bouton ci-dessous pour finaliser votre connexion. Cette étape protège votre
      lien de connexion contre les clics automatiques (antivirus, aperçu d'email).
    </p>
    <form method="POST" action="${props.action}">
      <input type="hidden" name="_csrf" value="${props.csrfToken}" />
      <button type="submit">Se connecter</button>
    </form>
  `;
  return renderLayout({
    branding: props.branding,
    title,
    maxWidth: 400,
    bodyHtml,
    // The confirm URL carries a one-shot magic-link token in its query.
    // Suppress `Referer` to prevent leakage if the user clicks an external
    // link (or if any embedded logo host receives a sub-request).
    noReferrer: true,
  });
}
