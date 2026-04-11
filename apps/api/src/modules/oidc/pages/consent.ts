// SPDX-License-Identifier: Apache-2.0

/**
 * End-user consent page.
 *
 * Served at GET /api/oauth/enduser/consent after a successful login. The
 * Better Auth oauth-provider plugin hands the flow off here with a pending
 * authorization-code state; the user sees the client's name + requested
 * scopes and clicks "Autoriser" or "Refuser". The form POST completes the
 * authorization code exchange back inside the plugin.
 *
 * A CSRF token pairs with a signed cookie to prevent cross-site consent
 * forgery — the POST handler rejects any submission where the token body
 * field does not match the cookie.
 */

import { html, type RawHtml } from "./html.ts";
import { renderLayout } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

const SCOPE_DESCRIPTIONS_FR: Record<string, string> = {
  openid: "Votre identité",
  profile: "Votre profil",
  email: "Votre adresse email",
  offline_access: "Rester connecté (jeton de rafraîchissement)",
  "agents:read": "Lister vos agents",
  "agents:run": "Lancer des agents pour vous",
  "runs:read": "Consulter votre historique d'exécutions",
  "runs:cancel": "Annuler vos exécutions en cours",
  "connections:read": "Lister vos connexions",
  "connections:connect": "Ajouter des connexions en votre nom",
  "connections:disconnect": "Retirer vos connexions",
  "skills:read": "Lister les skills disponibles",
  "tools:read": "Lister les tools disponibles",
  "providers:read": "Lister les providers disponibles",
  "models:read": "Lister les modèles LLM disponibles",
};

function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS_FR[scope] ?? scope;
}

export interface ConsentPageProps {
  clientName: string;
  scopes: string[];
  /** Form action — typically `/api/oauth/enduser/consent${queryString}`. */
  action: string;
  /** CSRF token injected into the form + paired cookie. */
  csrfToken: string;
  /** Resolved branding for the owning application. */
  branding: ResolvedAppBranding;
}

export function renderConsentPage(props: ConsentPageProps): RawHtml {
  const scopeItems = props.scopes.map((s) => html`<li>${describeScope(s)}</li>`);
  const title = `Autorisation — ${props.branding.name}`;
  const bodyHtml = html`
    <h1>Autorisation</h1>
    <p>
      <span class="client">${props.clientName}</span> souhaite accéder à votre compte
      ${props.branding.name}.
    </p>
    <p>Cette application aura accès à :</p>
    <ul class="scopes">
      ${scopeItems}
    </ul>
    <div class="actions">
      <form method="POST" action="${props.action}">
        <input type="hidden" name="_csrf" value="${props.csrfToken}" />
        <input type="hidden" name="accept" value="false" />
        <button type="submit" class="deny">Refuser</button>
      </form>
      <form method="POST" action="${props.action}">
        <input type="hidden" name="_csrf" value="${props.csrfToken}" />
        <input type="hidden" name="accept" value="true" />
        <button type="submit" class="allow">Autoriser</button>
      </form>
    </div>
  `;
  return renderLayout({ branding: props.branding, title, maxWidth: 440, bodyHtml });
}
