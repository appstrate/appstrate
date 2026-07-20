// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

function html(nonce: string, displayName: string): string {
  const escaped = displayName.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"><title>Appstrate</title><style>body{font:16px system-ui;max-width:560px;margin:10vh auto;padding:24px;color:#171717}button{font:inherit;padding:12px 18px;border:0;border-radius:8px;background:#111;color:white;cursor:pointer}p{line-height:1.5;color:#555}</style><h1>Connexion ${escaped}</h1><p>Connectez-vous dans l’autre onglet. Une fois votre compte ouvert, revenez ici puis confirmez. Seules les données de session des domaines autorisés seront transférées à votre instance Appstrate.</p><form method="post" action="/complete"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">J’ai terminé la connexion</button></form></html>`;
}

export interface CompanionControlServer {
  url: string;
  completed: Promise<void>;
  stop(): void;
}

export function startControlServer(displayName: string): CompanionControlServer {
  const nonce = randomBytes(24).toString("base64url");
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(html(nonce, displayName), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/complete") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== server.url.origin)
          return new Response("Forbidden", { status: 403 });
        const body = await request.formData();
        if (body.get("nonce") !== nonce) return new Response("Forbidden", { status: 403 });
        resolveCompleted();
        return new Response(
          "<!doctype html><p>Transfert en cours. Vous pouvez fermer cet onglet.</p>",
          {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    url: server.url.href,
    completed,
    stop: () => server.stop(true),
  };
}
