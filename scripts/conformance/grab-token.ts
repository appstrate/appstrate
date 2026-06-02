// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot OAuth token grabber for remote MCP integrations — a DEV UTILITY for
 * obtaining a `CONFORMANCE_TOKENS` bearer to exercise the live `--tier mcp`
 * checks against auth-gated servers (ClickUp, Notion).
 *
 *   bun scripts/conformance/grab-token.ts @appstrate/clickup-mcp [--port 8989] [--client-id <id>]
 *
 * Reuses `@appstrate/connect` for endpoint discovery + RFC 7591 dynamic client
 * registration, then runs the loopback PKCE authorization-code dance: registers
 * a public client (or `--client-id`), opens the browser for consent, captures
 * the code on 127.0.0.1, exchanges it, and prints a ready-to-paste
 * CONFORMANCE_TOKENS line. The token is only printed, never written to disk.
 *
 * Targets public-client OAuth servers (`token_endpoint_auth_method: "none"` +
 * issuer discovery) — clickup-mcp / notion-mcp. github-mcp uses a confidential
 * client; cover it with a PAT in `CONFORMANCE_TOKENS` instead.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadSystemPackages } from "@appstrate/core/system-packages";
import { resolveOAuthEndpoints, registerDynamicClient } from "@appstrate/connect";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

interface OAuthAuth {
  issuer?: string;
  default_scopes?: string[];
  _meta?: { "dev.appstrate/oauth"?: { scope_separator?: string } };
}

async function main(): Promise<void> {
  const packageId = process.argv[2];
  if (!packageId || packageId.startsWith("--")) {
    throw new Error(
      "usage: bun scripts/conformance/grab-token.ts <packageId> [--port N] [--client-id ID]",
    );
  }
  const port = Number(flag("--port") ?? 8989);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const dir = join(import.meta.dir, "../../system-packages");
  const { packages } = await loadSystemPackages(dir);
  const entry = packages.find((p) => p.packageId === packageId);
  if (!entry) throw new Error(`package not found in ${dir}: ${packageId}`);

  const auths = (entry.manifest.auths ?? {}) as Record<string, OAuthAuth>;
  const authEntry = Object.values(auths).find((a) => a.issuer);
  if (!authEntry?.issuer) {
    throw new Error(
      `${packageId}: no oauth2 auth with an issuer (use a PAT for confidential ones)`,
    );
  }
  const issuer = authEntry.issuer;
  const scopes = authEntry.default_scopes ?? [];
  const scopeSep = authEntry._meta?.["dev.appstrate/oauth"]?.scope_separator ?? " ";
  const resource = (entry.manifest.source as { remote?: { url?: string } })?.remote?.url;

  console.log(`[grab-token] ${packageId}  issuer: ${issuer}`);

  const endpoints = await resolveOAuthEndpoints({ issuer });
  if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) {
    throw new Error(`could not discover authorize/token endpoints from ${issuer}`);
  }

  let clientId = flag("--client-id");
  if (!clientId) {
    if (!endpoints.registrationEndpoint) {
      throw new Error(
        `no registration_endpoint advertised by ${issuer} — pass --client-id <id> for a pre-registered client`,
      );
    }
    const reg = await registerDynamicClient({
      registrationEndpoint: endpoints.registrationEndpoint,
      redirectUri,
      clientName: "Appstrate conformance harness",
      scopes,
      tokenEndpointAuthMethod: "none",
    });
    clientId = reg.clientId;
    console.log(`[grab-token] registered public client: ${clientId}`);
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  if (scopes.length) authUrl.searchParams.set("scope", scopes.join(scopeSep));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (resource) authUrl.searchParams.set("resource", resource);

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
        const err = url.searchParams.get("error");
        if (err) {
          queueMicrotask(() => {
            server.stop();
            reject(new Error(`authorization denied: ${err}`));
          });
          return new Response(`Authorization failed: ${err}`, { status: 400 });
        }
        const got = url.searchParams.get("code");
        if (!got || url.searchParams.get("state") !== state) {
          queueMicrotask(() => {
            server.stop();
            reject(new Error("missing code or state mismatch on callback"));
          });
          return new Response("invalid callback", { status: 400 });
        }
        queueMicrotask(() => {
          server.stop();
          resolve(got);
        });
        return new Response(
          "<html><body><h2>Appstrate — authorized.</h2>You can close this tab.</body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    console.log(`[grab-token] listening on ${redirectUri} — opening browser, approve consent.`);
    console.log(`[grab-token] if it doesn't open, paste:\n\n${authUrl.toString()}\n`);
    spawn("open", [authUrl.toString()], { stdio: "ignore" }).on("error", () => {});
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    ...(resource ? { resource } : {}),
  });
  const res = await fetch(endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text}`);
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error(`token response had no access_token: ${text}`);

  console.log(`\n[grab-token] success. Run the live check with:\n`);
  console.log(`CONFORMANCE_TOKENS='${JSON.stringify({ [packageId]: json.access_token })}' \\`);
  console.log(`  bun run test:system-packages --tier mcp --pkg ${entry.name}\n`);
}

main().catch((err) => {
  console.error(`[grab-token] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
