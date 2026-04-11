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
 * Stage 5 scope: GET page renders from a pre-loaded `ConsentContext`
 * (client name + scope list). POST is stubbed with 501 until Stage 5.5
 * lands the plugin wiring.
 */

import { html, type RawHtml } from "./html.ts";

const SCOPE_DESCRIPTIONS_FR: Record<string, string> = {
  openid: "Votre identité",
  profile: "Votre profil",
  email: "Votre adresse email",
  connections: "Vos connexions (lecture)",
  "connections:write": "Vos connexions (lecture et écriture)",
  runs: "Votre historique d'exécutions (lecture)",
  "runs:write": "Lancer des agents pour vous",
  agents: "Vos agents (lecture)",
  "agents:write": "Vos agents (lecture et exécution)",
};

function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS_FR[scope] ?? scope;
}

export interface ConsentPageProps {
  clientName: string;
  scopes: string[];
  /** Form action — typically `/api/oauth/enduser/consent${queryString}`. */
  action: string;
}

export function renderConsentPage(props: ConsentPageProps): RawHtml {
  const scopeItems = props.scopes.map((s) => html`<li>${describeScope(s)}</li>`);
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Autorisation</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            max-width: 440px;
            margin: 80px auto;
            padding: 0 20px;
            color: #111;
          }
          h1 {
            font-size: 1.5rem;
          }
          p {
            color: #555;
          }
          .client {
            font-weight: 600;
            color: #111;
          }
          ul.scopes {
            list-style: none;
            padding: 0;
            margin: 16px 0 24px;
            border-top: 1px solid #eee;
          }
          ul.scopes li {
            padding: 10px 0;
            border-bottom: 1px solid #eee;
          }
          .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
          }
          .actions form {
            flex: 1;
            margin: 0;
          }
          button {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
          }
          .allow {
            background: #4f46e5;
            color: white;
          }
          .allow:hover {
            background: #4338ca;
          }
          .deny {
            background: #e5e7eb;
            color: #374151;
          }
          .deny:hover {
            background: #d1d5db;
          }
        </style>
      </head>
      <body>
        <h1>Autorisation</h1>
        <p>
          <span class="client">${props.clientName}</span> souhaite accéder à votre compte Appstrate.
        </p>
        <p>Cette application aura accès à :</p>
        <ul class="scopes">
          ${scopeItems}
        </ul>
        <div class="actions">
          <form method="POST" action="${props.action}">
            <input type="hidden" name="accept" value="false" />
            <button type="submit" class="deny">Refuser</button>
          </form>
          <form method="POST" action="${props.action}">
            <input type="hidden" name="accept" value="true" />
            <button type="submit" class="allow">Autoriser</button>
          </form>
        </div>
      </body>
    </html> `;
}
