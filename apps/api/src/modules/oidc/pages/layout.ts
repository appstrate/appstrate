// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTML layout for the OIDC module's server-rendered end-user pages
 * (login + consent). Owns `<!doctype>`, `<head>`, the common CSS block
 * (typography, colors, header.brand) and the branding header. Page-specific
 * forms are passed in via `bodyHtml` so each page only defines its own
 * body markup.
 *
 * The CSS is intentionally byte-identical to the pre-extract layout used
 * by login.ts and consent.ts — only the `maxWidth` is parameterised so
 * login keeps its 400px column and consent keeps its 440px column.
 */

import { html, type RawHtml } from "./html.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface LayoutProps {
  branding: ResolvedAppBranding;
  /** Document title — typically "Connexion à {brand}" or "Autorisation — {brand}". */
  title: string;
  /** Form body — already escaped via the `html` helper. */
  bodyHtml: RawHtml;
  /** Column width in pixels — 400 for login, 440 for consent. */
  maxWidth: number;
}

export function renderLayout(props: LayoutProps): RawHtml {
  const { name: brandName, logoUrl, primaryColor: primary, accentColor: accent } = props.branding;
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${props.title}</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            max-width: ${props.maxWidth}px;
            margin: 80px auto;
            padding: 0 20px;
            color: #111;
          }
          header.brand {
            text-align: center;
            margin-bottom: 24px;
          }
          header.brand img {
            max-height: 48px;
            max-width: 200px;
            display: block;
            margin: 0 auto 12px;
          }
          header.brand .name {
            font-size: 14px;
            font-weight: 600;
            color: #111;
            letter-spacing: 0.02em;
          }
          h1 {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
          }
          p {
            color: #555;
          }
          form {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-top: 24px;
          }
          input {
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 6px;
            font-size: 16px;
          }
          button {
            padding: 12px;
            background: ${primary};
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
          }
          button:hover {
            background: ${accent};
          }
          .error {
            color: #dc2626;
            font-size: 14px;
            padding: 8px 12px;
            background: #fef2f2;
            border-radius: 6px;
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
          .allow {
            background: ${primary};
            color: white;
            width: 100%;
          }
          .allow:hover {
            background: ${accent};
          }
          .deny {
            background: #e5e7eb;
            color: #374151;
            width: 100%;
          }
          .deny:hover {
            background: #d1d5db;
          }
          .divider {
            display: flex;
            align-items: center;
            margin: 20px 0;
            color: #888;
            font-size: 13px;
          }
          .divider::before,
          .divider::after {
            content: "";
            flex: 1;
            border-bottom: 1px solid #ddd;
          }
          .divider span {
            padding: 0 12px;
          }
          .social-buttons {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .social-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 10px 16px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            text-decoration: none;
            color: #333;
            background: #fff;
            cursor: pointer;
            transition:
              background 0.15s,
              border-color 0.15s;
          }
          .social-btn:hover {
            background: #f5f5f5;
            border-color: #bbb;
          }
          .social-btn svg {
            flex-shrink: 0;
          }
          .footer-links {
            text-align: center;
            margin-top: 20px;
            font-size: 13px;
            color: #888;
          }
          .footer-links a {
            color: ${primary};
            text-decoration: none;
          }
          .footer-links a:hover {
            text-decoration: underline;
          }
          .footer-links .sep {
            margin: 0 8px;
          }
        </style>
      </head>
      <body>
        <header class="brand">
          ${logoUrl ? html`<img src="${logoUrl}" alt="${brandName}" />` : null}
          <div class="name">${brandName}</div>
        </header>
        ${props.bodyHtml}
      </body>
    </html> `;
}
