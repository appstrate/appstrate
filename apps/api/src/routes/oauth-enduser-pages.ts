// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth End-User Pages
 *
 * Minimal server-rendered pages for the OIDC authorization flow.
 * The oauth-provider plugin redirects unauthenticated users to loginPage,
 * and authenticated users to consentPage before issuing authorization codes.
 *
 * Phase 1: basic HTML forms. Phase 3: branded hosted pages with full UI.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import type { AppEnv } from "../types/index.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";

/** OAuth query params safe to forward — prevents XSS via arbitrary query injection. */
const ALLOWED_OAUTH_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
];

/** Known scope labels — unknown scopes are filtered out (not rendered). */
const SCOPE_LABELS: Record<string, string> = {
  openid: "Votre identité",
  profile: "Votre profil",
  email: "Votre email",
  connections: "Vos connexions (lecture)",
  "connections:write": "Vos connexions (écriture)",
  runs: "Votre historique (lecture)",
  "runs:write": "Lancer des agents",
  agents: "Vos agents (lecture)",
  "agents:write": "Gérer vos agents",
  schedules: "Vos planifications (lecture)",
};

export function createOAuthEndUserPagesRouter() {
  const router = new Hono<AppEnv>();

  // Rate limit all OIDC pages (60 req/min per IP)
  router.use("*", rateLimitByIp(60));

  // GET /oauth/enduser/login — Login page (redirected from /oauth2/authorize)
  router.get("/login", async (c) => {
    // Parse and re-serialize only expected OAuth params to prevent XSS via query injection.
    // CSRF: Better Auth validates Origin header against trustedOrigins on all POST endpoints.
    const url = new URL(c.req.url);
    const safeParams = new URLSearchParams();
    for (const key of ALLOWED_OAUTH_PARAMS) {
      const val = url.searchParams.get(key);
      if (val) safeParams.set(key, val);
    }
    const safeQuery = safeParams.toString() ? `?${safeParams.toString()}` : "";

    return c.html(html`
      <!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Connexion</title>
          <style>
            body {
              font-family: system-ui, sans-serif;
              max-width: 400px;
              margin: 80px auto;
              padding: 0 20px;
            }
            form {
              display: flex;
              flex-direction: column;
              gap: 12px;
            }
            input {
              padding: 10px;
              border: 1px solid #ccc;
              border-radius: 6px;
              font-size: 16px;
            }
            button {
              padding: 12px;
              background: #4f46e5;
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 16px;
              cursor: pointer;
            }
            button:hover {
              background: #4338ca;
            }
            .error {
              color: #dc2626;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <h1>Connexion</h1>
          <p>Connectez-vous pour continuer.</p>
          <form method="POST" action="/api/auth/sign-in/email">
            <input type="hidden" name="callbackURL" value="/oauth2/authorize${safeQuery}" />
            <input type="email" name="email" placeholder="Email" required autofocus />
            <input type="password" name="password" placeholder="Mot de passe" required />
            <button type="submit">Se connecter</button>
          </form>
          <p style="margin-top: 24px; font-size: 14px; color: #666">
            <a
              href="/api/auth/sign-up/email${safeQuery
                ? `?callbackURL=/oauth2/authorize${encodeURIComponent(safeQuery)}`
                : ""}"
              >Créer un compte</a
            >
          </p>
        </body>
      </html>
    `);
  });

  // GET /oauth/enduser/consent — Consent page
  router.get("/consent", async (c) => {
    const scope = c.req.query("scope") ?? "openid";

    return c.html(html`
      <!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Autorisation</title>
          <style>
            body {
              font-family: system-ui, sans-serif;
              max-width: 400px;
              margin: 80px auto;
              padding: 0 20px;
            }
            .scopes {
              list-style: none;
              padding: 0;
            }
            .scopes li {
              padding: 8px 0;
              border-bottom: 1px solid #eee;
            }
            .actions {
              display: flex;
              gap: 12px;
              margin-top: 24px;
            }
            button {
              flex: 1;
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
            .deny {
              background: #e5e7eb;
              color: #374151;
            }
          </style>
        </head>
        <body>
          <h1>Autorisation</h1>
          <p>L'application demande l'accès à :</p>
          <ul class="scopes">
            ${scope
              .split(" ")
              .filter((s: string) => SCOPE_LABELS[s])
              .map((s: string) => html`<li>${SCOPE_LABELS[s]}</li>`)}
          </ul>
          <div class="actions">
            <button onclick="submitConsent(false)" class="deny" style="flex:1">Refuser</button>
            <button onclick="submitConsent(true)" class="allow" style="flex:1">Autoriser</button>
          </div>
          <script>
            async function submitConsent(accept) {
              const oauthQuery = window.location.search.substring(1);
              const res = await fetch("/api/auth/oauth2/consent", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accept, oauth_query: oauthQuery }),
              });
              const data = await res.json();
              if (data.redirect && data.url) {
                window.location.href = data.url;
              } else if (data.error) {
                const p = document.createElement("p");
                p.className = "error";
                p.textContent = data.error_description || data.error || "Unknown error";
                document.body.appendChild(p);
              }
            }
          </script>
        </body>
      </html>
    `);
  });

  return router;
}
