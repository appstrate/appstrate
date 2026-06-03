// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot OAuth token grabber for remote/credential-only integrations — a DEV
 * UTILITY for obtaining a `CONFORMANCE_TOKENS` bearer to exercise the live
 * checks against auth-gated providers.
 *
 *   bun scripts/conformance/grab-token.ts <packageId> [options]
 *     --port N            loopback port (default 8989)
 *     --client-id ID      pre-registered client (required for confidential)
 *     --client-secret S   client secret (confidential clients, e.g. Google)
 *     --issuer URL        force OIDC discovery from this issuer (overrides the
 *                         manifest's explicit endpoints — e.g. point a Google
 *                         integration at https://accounts.google.com)
 *     --offline           request a refresh token: adds the `offline_access`
 *                         scope (OAuth-2.1 servers, e.g. Notion MCP) AND
 *                         Google's access_type=offline + prompt=consent
 *
 * Reuses `@appstrate/connect` for endpoint discovery + RFC 7591 dynamic client
 * registration, then runs the loopback PKCE authorization-code dance and prints
 * a ready-to-paste CONFORMANCE_TOKENS line. The token is only printed.
 *
 * Public clients (`token_endpoint_auth_method: "none"`, e.g. clickup/notion)
 * self-register via DCR. Confidential clients (`client_secret_*`, e.g. Google,
 * Slack, HubSpot, github-mcp) need a manually-created OAuth app + --client-id
 * --client-secret.
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
  authorization_endpoint?: string;
  token_endpoint?: string;
  token_endpoint_auth_method?: string;
  default_scopes?: string[];
  _meta?: { "dev.appstrate/oauth"?: { scope_separator?: string } };
}

async function main(): Promise<void> {
  const packageId = process.argv[2];
  if (!packageId || packageId.startsWith("--")) {
    throw new Error(
      "usage: bun scripts/conformance/grab-token.ts <packageId> [--port N] [--client-id ID] [--client-secret S] [--issuer URL] [--offline]",
    );
  }
  const port = Number(flag("--port") ?? 8989);
  const offline = process.argv.includes("--offline");
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const dir = join(import.meta.dir, "../../system-packages");
  const { packages } = await loadSystemPackages(dir);
  const entry = packages.find((p) => p.packageId === packageId);
  if (!entry) throw new Error(`package not found in ${dir}: ${packageId}`);

  const auths = (entry.manifest.auths ?? {}) as Record<string, OAuthAuth>;
  const authEntry = Object.values(auths).find(
    (a) => a.issuer || (a.authorization_endpoint && a.token_endpoint),
  );
  if (!authEntry) {
    throw new Error(`${packageId}: no oauth2 auth (issuer or explicit endpoints) in the manifest`);
  }
  const scopes = authEntry.default_scopes ?? [];
  const scopeSep = authEntry._meta?.["dev.appstrate/oauth"]?.scope_separator ?? " ";
  const resource = (entry.manifest.source as { remote?: { url?: string } })?.remote?.url;
  const authMethod = authEntry.token_endpoint_auth_method ?? "none";
  const isConfidential = authMethod.startsWith("client_secret");

  console.log(`[grab-token] ${packageId}`);

  // Resolve endpoints — discovery from the (optionally overridden) issuer, else
  // explicit from the manifest. `--issuer` exercises the OIDC autodiscover path
  // even when the manifest hardcodes endpoints.
  const issuer = flag("--issuer") ?? authEntry.issuer;
  let authorizationEndpoint = authEntry.authorization_endpoint;
  let tokenEndpoint = authEntry.token_endpoint;
  let registrationEndpoint: string | undefined;
  if (issuer) {
    console.log(`[grab-token] discovering from issuer: ${issuer}`);
    const ep = await resolveOAuthEndpoints({ issuer });
    authorizationEndpoint = ep.authorizationEndpoint ?? authorizationEndpoint;
    tokenEndpoint = ep.tokenEndpoint ?? tokenEndpoint;
    registrationEndpoint = ep.registrationEndpoint;
    console.log(`[grab-token] → authorize=${authorizationEndpoint}  token=${tokenEndpoint}`);
  }
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(`${packageId}: could not resolve authorize/token endpoints`);
  }

  let clientId = flag("--client-id");
  const clientSecret = flag("--client-secret") ?? "";
  if (!clientId) {
    if (isConfidential) {
      throw new Error(
        `${packageId}: confidential client ("${authMethod}") — create an OAuth app with redirect ` +
          `${redirectUri} and pass --client-id <id> --client-secret <secret>`,
      );
    }
    if (!registrationEndpoint) {
      throw new Error(
        `${packageId}: no registration_endpoint — pass --client-id <id> for a pre-registered client`,
      );
    }
    const reg = await registerDynamicClient({
      registrationEndpoint,
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

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  // `--offline` requests a refresh token. Two mechanisms, applied together so a
  // single flag covers the fleet: the OIDC `offline_access` scope (OAuth-2.1
  // servers like Notion MCP — `refresh_token` in grant_types_supported) AND
  // Google's proprietary `access_type=offline` + forced `prompt=consent` query
  // params (Google ignores the scope). Each side ignores the other's mechanism.
  const requestedScopes =
    offline && !scopes.includes("offline_access") ? [...scopes, "offline_access"] : scopes;
  if (requestedScopes.length) authUrl.searchParams.set("scope", requestedScopes.join(scopeSep));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (resource) authUrl.searchParams.set("resource", resource);
  if (offline) {
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
  }

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
    ...(isConfidential && clientSecret ? { client_secret: clientSecret } : {}),
    ...(resource ? { resource } : {}),
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text}`);
  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string };
  if (!json.access_token) throw new Error(`token response had no access_token: ${text}`);

  console.log(`\n[grab-token] success.\n`);
  console.log(`# Quick one-off check (access token — may expire):`);
  console.log(`CONFORMANCE_TOKENS='${JSON.stringify({ [packageId]: json.access_token })}' \\`);
  console.log(`  bun run test:system-packages --tier all --pkg ${entry.name}\n`);

  if (json.refresh_token) {
    // Self-renewing form — use as the CI secret so the cron mints a fresh
    // access token each run (e.g. Google's 1h tokens).
    const refreshForm = {
      [packageId]: {
        refresh_token: json.refresh_token,
        client_id: clientId,
        ...(isConfidential
          ? { client_secret: clientSecret, token_endpoint_auth_method: authMethod }
          : {}),
        token_endpoint: tokenEndpoint,
      },
    };
    console.log(`# Self-renewing form — set this as the CONFORMANCE_TOKENS CI secret:`);
    console.log(`${JSON.stringify(refreshForm)}\n`);
    console.log(
      `# (Google: publish the OAuth consent screen, else the refresh token expires in 7 days.)\n`,
    );
  } else if (offline) {
    console.log(
      `# Note: no refresh_token returned despite --offline (provider doesn't issue one).\n`,
    );
  }
}

main().catch((err) => {
  console.error(`[grab-token] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
