// SPDX-License-Identifier: Apache-2.0

/**
 * End-user consent page.
 *
 * Served at GET /api/oauth/consent after a successful login. The
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
import type { ResolvedSpaceBranding } from "../services/branding.ts";
import type { OAuthClientLevel } from "../services/oauth-admin.ts";

/**
 * Consent-screen descriptions, French (the hosted OAuth pages are FR-only).
 * Exported so the scope-label parity test can assert coverage against the
 * authoritative scope vocabulary.
 */
export const SCOPE_DESCRIPTIONS_FR: Record<string, string> = {
  openid: "Votre identité",
  profile: "Votre profil",
  email: "Votre adresse email",
  offline_access: "Rester connecté (jeton de rafraîchissement)",
  "agents:read": "Lister vos agents",
  "agents:run": "Lancer des agents pour vous",
  "runs:read": "Consulter votre historique d'exécutions",
  "runs:cancel": "Annuler vos exécutions en cours",
  "files:read": "Consulter les fichiers produits par vos exécutions",
  "integrations:read": "Lister vos intégrations et connexions",
  "integrations:connect": "Ajouter des connexions en votre nom",
  "integrations:disconnect": "Retirer vos connexions",
  "skills:read": "Lister les skills disponibles",
  "models:read": "Lister les modèles LLM disponibles",
  "llm-proxy:call": "Utiliser les modèles LLM configurés en votre nom",
  // Module-contributed scopes (MCP module, `endUserGrantable`). Not in the
  // static `APPSTRATE_BUILTIN_SCOPES` list, but requestable at runtime — so
  // they need a description here just the same.
  "mcp:read": "Découvrir les opérations disponibles via MCP",
  "mcp:invoke": "Exécuter des opérations via MCP en votre nom",
};

/**
 * Human description for a scope, falling back to the raw scope string.
 *
 * The fallback keeps the page rendering, but a user asked to grant
 * `llm-proxy:call` verbatim cannot meaningfully consent — so the fallback is a
 * crash guard, never the plan. `test/unit/oauth-scope-labels.test.ts` fails when
 * an authoritative scope reaches here without an entry above (and does the same
 * for the dashboard's `oauthClients.scopeLabels.*` locale keys).
 */
function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS_FR[scope] ?? scope;
}

interface ConsentPageProps {
  clientName: string;
  scopes: string[];
  /**
   * Level of the client the user is authorizing. Decides whether the scope
   * list is described as a limit — see `REACH_NOTICE_FR`.
   */
  clientLevel: OAuthClientLevel;
  /** Form action — typically `/api/oauth/consent${queryString}`. */
  action: string;
  /** CSRF token injected into the form + paired cookie. */
  csrfToken: string;
  /** Resolved branding for the owning space. */
  branding: ResolvedSpaceBranding;
  /** Optional error message displayed above the form. */
  error?: string;
}

/**
 * What an `instance`-level authorization actually grants, in the user's words.
 *
 * The scope list above it is NOT a permission ceiling for such a client: its
 * token carries `actor_type: "user"`, `scopesToPermissions` returns an empty
 * set for that actor (`auth/claims.ts`) and the pipeline writes no
 * `scopeCeiling` for it (`lib/auth-pipeline.ts`) — the request is served with
 * whatever the user's live org role allows. Listing `mcp:invoke` and stopping
 * there would let the user believe the app is capped at what it enumerated.
 *
 * `org` and `space` clients need no such notice: their tokens DO carry the
 * scope claim as a ceiling (`dashboard_user` intersects it with the live role,
 * `end_user` gets exactly the claim), so the list is the limit it looks like.
 */
const REACH_NOTICE_FR =
  "Cette application se connecte en votre nom : dans l'organisation qu'elle cible, " +
  "elle agit avec vos propres droits. La liste ci-dessus décrit l'accès demandé, " +
  "elle ne le restreint pas.";

export function renderConsentPage(props: ConsentPageProps): RawHtml {
  const scopeItems = props.scopes.map((s) => html`<li>${describeScope(s)}</li>`);
  const reachNotice =
    props.clientLevel === "instance" ? html`<p class="notice">${REACH_NOTICE_FR}</p>` : "";
  const title = `Autorisation — ${props.branding.name}`;
  const errorBlock = props.error ? html`<div class="error" role="alert">${props.error}</div>` : "";
  const bodyHtml = html`
    <h1>Autorisation</h1>
    ${errorBlock}
    <p>
      <span class="client">${props.clientName}</span> souhaite accéder à votre compte
      ${props.branding.name}.
    </p>
    <p>Cette space aura accès à :</p>
    <ul class="scopes">
      ${scopeItems}
    </ul>
    ${reachNotice}
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
