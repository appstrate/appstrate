// SPDX-License-Identifier: Apache-2.0

/**
 * `/activate` — RFC 8628 device-flow user-facing verification page.
 *
 * Three renders feed off this module:
 *
 *   1. `renderActivateEntryPage` — no `user_code` in the query. Asks the
 *      user to type the 8-character code displayed by the CLI. The input
 *      accepts either `XXXX-XXXX` or `XXXXXXXX` — the form handler strips
 *      dashes before delegating to BA.
 *
 *   2. `renderActivateConsentPage` — `user_code` is present and resolves
 *      to a pending `device_codes` row. Shows the client name, scopes,
 *      and approve/deny buttons (CSRF-paired). RFC 8628 § 5.2 explicitly
 *      requires this confirmation step as the anti-phishing mitigation
 *      for the device grant — never skipped, regardless of
 *      `oauth_clients.is_first_party`.
 *
 *   3. `renderActivateResultPage` — terminal state after approve/deny.
 *      Tells the user they can close the tab and return to the CLI.
 *
 * Every dynamic value flows through the XSS-safe `html` tagged template
 * from `./html.ts`. The layout/CSS comes from `./layout.ts` (shared with
 * login + consent — same typography, same column width at 440px).
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

/** Common props across the three renders — all of them need branding. */
interface ActivateBaseProps {
  branding: ResolvedAppBranding;
  /** Optional error message displayed above the form. */
  error?: string;
}

export interface ActivateEntryPageProps extends ActivateBaseProps {
  /** CSRF token for the `POST /activate` user-code submission form. */
  csrfToken: string;
  /** Optional pre-fill for the user_code input (when the link from the CLI includes it). */
  initialUserCode?: string;
}

export function renderActivateEntryPage(props: ActivateEntryPageProps): RawHtml {
  const errorBlock = props.error ? html`<div class="error" role="alert">${props.error}</div>` : "";
  const prefill = props.initialUserCode ?? "";
  const bodyHtml = html`
    <h1>Lier votre appareil</h1>
    ${errorBlock}
    <p>
      Entrez le code affiché par l'outil en ligne de commande pour autoriser l'accès à votre compte.
    </p>
    <form method="POST" action="/activate">
      <input type="hidden" name="_csrf" value="${props.csrfToken}" />
      <input
        type="text"
        name="user_code"
        autocomplete="one-time-code"
        placeholder="XXXX-XXXX"
        value="${prefill}"
        autofocus
        required
        inputmode="text"
        pattern="[A-Za-z-]{8,9}"
      />
      <button type="submit">Continuer</button>
    </form>
  `;
  return renderLayout({
    branding: props.branding,
    title: `Lier votre appareil — ${props.branding.name}`,
    maxWidth: 440,
    bodyHtml,
    noReferrer: true,
  });
}

export interface ActivateConsentPageProps extends ActivateBaseProps {
  /** Display name for the OAuth client requesting access (e.g. "Appstrate CLI"). */
  clientName: string;
  /** Normalized `XXXX-XXXX` code for display, plus the raw 8-char value echoed in the hidden input. */
  userCodeDisplay: string;
  userCodeRaw: string;
  /** Scopes declared on the device-code request (space-separated string split here for the list). */
  scopes: string[];
  /** CSRF token pairing the approve/deny buttons with a signed cookie. */
  csrfToken: string;
}

const SCOPE_DESCRIPTIONS_FR: Record<string, string> = {
  openid: "Votre identité",
  profile: "Votre profil",
  email: "Votre adresse email",
  offline_access: "Rester connecté (jeton de rafraîchissement)",
};

function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS_FR[scope] ?? scope;
}

export function renderActivateConsentPage(props: ActivateConsentPageProps): RawHtml {
  const scopeItems = props.scopes.map((s) => html`<li>${describeScope(s)}</li>`);
  const errorBlock = props.error ? html`<div class="error" role="alert">${props.error}</div>` : "";
  const bodyHtml = html`
    <h1>Autoriser ${props.clientName} ?</h1>
    ${errorBlock}
    <p>
      Vous êtes sur le point d'autoriser <span class="client">${props.clientName}</span> à accéder à
      votre compte ${props.branding.name} avec le code
      <span class="client">${props.userCodeDisplay}</span>.
    </p>
    <p>Cette application aura accès à :</p>
    <ul class="scopes">
      ${scopeItems}
    </ul>
    <p>
      Ne poursuivez que si vous venez de lancer la commande qui a affiché ce code. Dans le doute,
      cliquez sur Refuser.
    </p>
    <div class="actions">
      <form method="POST" action="/activate/deny">
        <input type="hidden" name="_csrf" value="${props.csrfToken}" />
        <input type="hidden" name="user_code" value="${props.userCodeRaw}" />
        <button type="submit" class="deny">Refuser</button>
      </form>
      <form method="POST" action="/activate/approve">
        <input type="hidden" name="_csrf" value="${props.csrfToken}" />
        <input type="hidden" name="user_code" value="${props.userCodeRaw}" />
        <button type="submit" class="allow">Autoriser</button>
      </form>
    </div>
  `;
  return renderLayout({
    branding: props.branding,
    title: `Autorisation — ${props.branding.name}`,
    maxWidth: 440,
    bodyHtml,
    noReferrer: true,
  });
}

export interface ActivateResultPageProps extends ActivateBaseProps {
  outcome: "approved" | "denied";
}

export function renderActivateResultPage(props: ActivateResultPageProps): RawHtml {
  const heading = props.outcome === "approved" ? "Appareil autorisé" : "Demande refusée";
  const defaultMessage =
    props.outcome === "approved"
      ? "Vous pouvez revenir à votre terminal. La commande en attente va se terminer automatiquement."
      : "La demande d'autorisation a été refusée. Vous pouvez fermer cet onglet.";
  const bodyHtml = html`
    <h1>${heading}</h1>
    ${props.error ? html`<div class="error" role="alert">${props.error}</div>` : null}
    <p>${props.error ?? defaultMessage}</p>
  `;
  return renderLayout({
    branding: props.branding,
    title: `${heading} — ${props.branding.name}`,
    maxWidth: 440,
    bodyHtml,
    noReferrer: true,
  });
}
