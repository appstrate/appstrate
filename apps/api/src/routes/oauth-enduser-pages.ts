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

export function createOAuthEndUserPagesRouter() {
  const router = new Hono<AppEnv>();

  // GET /oauth/enduser/login — Login page (redirected from /oauth2/authorize)
  router.get("/login", async (c) => {
    // The oauth-provider passes signed query params that must be forwarded
    const queryString = new URL(c.req.url).search;

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
            <input type="hidden" name="callbackURL" value="/oauth2/authorize${queryString}" />
            <input type="email" name="email" placeholder="Email" required autofocus />
            <input type="password" name="password" placeholder="Mot de passe" required />
            <button type="submit">Se connecter</button>
          </form>
          <p style="margin-top: 24px; font-size: 14px; color: #666">
            <a
              href="/api/auth/sign-up/email${queryString
                ? `?callbackURL=/oauth2/authorize${encodeURIComponent(queryString)}`
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
              .map(
                (s: string) =>
                  html`<li>
                    ${s === "openid"
                      ? "Votre identité"
                      : s === "profile"
                        ? "Votre profil"
                        : s === "email"
                          ? "Votre email"
                          : s === "connections"
                            ? "Vos connexions (lecture)"
                            : s === "connections:write"
                              ? "Vos connexions (écriture)"
                              : s === "runs"
                                ? "Votre historique (lecture)"
                                : s === "runs:write"
                                  ? "Lancer des agents"
                                  : s}
                  </li>`,
              )}
          </ul>
          <div class="actions">
            <form method="POST" action="/oauth2/consent" style="flex:1">
              <input type="hidden" name="accept" value="false" />
              <button type="submit" class="deny" style="width:100%">Refuser</button>
            </form>
            <form method="POST" action="/oauth2/consent" style="flex:1">
              <input type="hidden" name="accept" value="true" />
              <button type="submit" class="allow" style="width:100%">Autoriser</button>
            </form>
          </div>
        </body>
      </html>
    `);
  });

  return router;
}
