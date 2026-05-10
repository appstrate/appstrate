// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate connect <provider>` — connect a personal Codex / Claude Code
 * subscription to the active organization for use as an OAuth-billed model
 * provider.
 *
 * Why this lives in the CLI (not the dashboard): the public OAuth client_ids
 * baked into the official Codex / Claude Code CLIs only allowlist
 * `http://localhost:PORT/...` redirect_uris ⇒ a platform-hosted callback is
 * rejected by the provider's authorization server. We work around this by
 * delegating the loopback OAuth dance to the user's terminal (via
 * `@mariozechner/pi-ai`'s `loginOpenAICodex` / `loginAnthropic`, which spin
 * up a temporary HTTP listener on `127.0.0.1:1455` / `127.0.0.1:53692`),
 * receive the resulting tokens, and POST them to
 * `/api/model-providers-oauth/import` for persistence.
 *
 * Legal disclaimer surfaced before launching the flow:
 *   - Anthropic explicitly disabled third-party OAuth use of Pro/Max tokens
 *     server-side as of 2026-01-09. Connecting may get the user's
 *     subscription suspended.
 *   - OpenAI's Codex stance is grayer but the same business risk applies.
 *
 * Auth: re-uses the existing CLI session (`appstrate login` device flow).
 * The active org + application come from the pinned profile, identical to
 * every other authenticated CLI command.
 */

import { loginOpenAICodex, loginAnthropic } from "@mariozechner/pi-ai/oauth";
import open from "open";
import { resolveActiveProfile, requireLoggedIn } from "../lib/config.ts";
import { apiFetch } from "../lib/api.ts";
import { askText, confirm, exitWithError, intro, outro, spinner } from "../lib/ui.ts";

/** Slugs accepted on the CLI; mapped to AFPS package ids server-side. */
export type ConnectProviderSlug = "codex" | "claude";

const SLUG_TO_PACKAGE_ID: Readonly<Record<ConnectProviderSlug, string>> = Object.freeze({
  codex: "@appstrate/provider-codex",
  claude: "@appstrate/provider-claude-code",
});

const DISPLAY_NAME: Readonly<Record<ConnectProviderSlug, string>> = Object.freeze({
  codex: "ChatGPT (Codex / Plus / Pro / Business)",
  claude: "Claude (Pro / Max / Team)",
});

const DEFAULT_LABEL: Readonly<Record<ConnectProviderSlug, string>> = Object.freeze({
  codex: "ChatGPT",
  claude: "Claude",
});

export interface ConnectCommandOptions {
  /** Override the CLI profile used for the platform call. */
  profile?: string;
  /**
   * User-facing label persisted on the resulting model-provider credential
   * row. When absent, the command prompts (TTY) or falls back to the
   * provider default (non-TTY).
   */
  label?: string;
  /**
   * Skip the ToS warning prompt. Reserved for CI / scripted self-host
   * setups where the operator has already accepted the risk out-of-band.
   * Never offer to users — the warning carries the legal context.
   */
  yes?: boolean;
}

interface ImportResponse {
  providerKeyId: string;
  connectionId: string;
  providerPackageId: string;
  email?: string;
  subscriptionType?: string;
  availableModelIds: string[];
}

/**
 * Render the legal-risk preface for the chosen provider. The wording is
 * deliberately blunt — the platform is Apache-2.0 (so we're fine), but
 * the user's personal subscription is exposed to a real, currently-enforced
 * suspension policy on Anthropic's side.
 */
function renderTosWarning(slug: ConnectProviderSlug): string {
  const lines: string[] = [
    "",
    "  ⚠  Connecting a personal subscription as an OAuth model provider",
    "",
    "  Quota is shared across every member of the organization.",
    "  The connection can be revoked at any time on the provider's side.",
    "  This is not covered by your subscription's ToS for automated agentic use.",
    "",
  ];
  if (slug === "claude") {
    lines.push(
      "  ⚠  Anthropic actively blocks third-party use of Claude Pro/Max OAuth",
      "     tokens server-side since 2026-01-09. Using your Pro/Max account here",
      "     may result in your subscription being suspended.",
      "",
    );
  } else {
    lines.push(
      "  ⚠  OpenAI's stance on third-party use of Codex / ChatGPT subscription",
      "     OAuth tokens is unclear. Suspension is at OpenAI's discretion.",
      "",
    );
  }
  lines.push("  You are using this at your own risk.");
  return lines.join("\n");
}

/**
 * Open the provider's authorize URL in the user's default browser.
 * Failures (missing $BROWSER on a headless box, permission denied, etc.)
 * are intentionally swallowed — the URL is also printed to stdout so the
 * user can copy/paste it.
 */
async function tryOpenBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch {
    /* User can copy the URL from stdout. */
  }
}

/**
 * Run the loopback OAuth dance for the chosen provider via Pi's helpers.
 * Pi spins up an HTTP listener on the provider-specific loopback port,
 * exchanges the authorization code, and returns `OAuthCredentials`.
 *
 * The `onPrompt` / `onManualCodeInput` callbacks let the user paste the
 * code manually if the loopback bind fails (corporate firewalls, port
 * already in use). Both Pi helpers race the loopback listener against
 * `onManualCodeInput` and accept whichever resolves first.
 */
async function runLoopbackOAuth(slug: ConnectProviderSlug): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  subscriptionType?: string;
  /**
   * Codex only — pi-ai extracts this from the JWT and surfaces it as a
   * top-level field. We forward it to the platform so it can persist the
   * canonical value rather than re-deriving it (and risking a JWT-decode
   * mismatch with the upstream contract).
   */
  accountId?: string;
}> {
  const sp = spinner();
  sp.start(`Waiting for provider authorization (${DISPLAY_NAME[slug]})…`);

  const callbacks = {
    onAuth: (info: { url: string; instructions?: string }): void => {
      sp.stop("Open the URL below in your browser to authorize:");
      process.stdout.write(`\n  ${info.url}\n`);
      if (info.instructions) process.stdout.write(`\n${info.instructions}\n`);
      void tryOpenBrowser(info.url);
      sp.start("Waiting for callback from provider…");
    },
    onPrompt: async (prompt: { message: string; placeholder?: string }): Promise<string> => {
      sp.stop();
      const value = await askText(prompt.message);
      sp.start("Exchanging authorization code…");
      return value;
    },
    onProgress: (message: string): void => {
      sp.stop(message);
      sp.start(message);
    },
  } as const;

  try {
    const creds =
      slug === "codex" ? await loginOpenAICodex(callbacks) : await loginAnthropic(callbacks);
    sp.stop("Authorization received.");
    // Pi's OAuthCredentials shape: { access, refresh, expires (ms epoch), [extras] }
    const subscriptionType =
      typeof (creds as Record<string, unknown>).subscription_type === "string"
        ? ((creds as Record<string, unknown>).subscription_type as string)
        : undefined;
    const account = (creds as Record<string, unknown>).account as
      | Record<string, unknown>
      | undefined;
    const accountEmail =
      account && typeof account.email_address === "string"
        ? (account.email_address as string)
        : undefined;
    const directEmail =
      typeof (creds as Record<string, unknown>).email === "string"
        ? ((creds as Record<string, unknown>).email as string)
        : undefined;
    const accountId =
      typeof (creds as Record<string, unknown>).accountId === "string"
        ? ((creds as Record<string, unknown>).accountId as string)
        : undefined;
    if (slug === "codex" && !accountId) {
      // Surface the actual shape pi-ai returned so we can spot a renamed
      // field — historically `accountId` but pi-ai's contract is `[key:
      // string]: unknown` so any future rename would silently strip it.
      process.stderr.write(
        `[appstrate connect] warning: pi-ai login returned no accountId field. Available keys: ${Object.keys(
          creds as Record<string, unknown>,
        ).join(", ")}\n`,
      );
    }
    return {
      accessToken: creds.access,
      refreshToken: creds.refresh,
      expiresAt: typeof creds.expires === "number" ? creds.expires : 0,
      email: directEmail ?? accountEmail,
      subscriptionType,
      accountId,
    };
  } catch (err) {
    sp.stop("Authorization failed.");
    throw err;
  }
}

export async function connectCommand(
  slug: ConnectProviderSlug,
  opts: ConnectCommandOptions,
): Promise<void> {
  const providerPackageId = SLUG_TO_PACKAGE_ID[slug];
  if (!providerPackageId) {
    process.stderr.write(`Unknown provider: ${slug}. Use 'codex' or 'claude'.\n`);
    process.exit(1);
  }

  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);
  if (!profile.orgId) {
    process.stderr.write(
      "No active organization. Run: appstrate org switch <id|slug>\n" +
        "(the connection is created on the active org's currently-pinned application).\n",
    );
    process.exit(1);
  }
  if (!profile.applicationId) {
    process.stderr.write(
      "No active application. Run: appstrate app switch <id|slug>\n" +
        "(provider connections are application-scoped).\n",
    );
    process.exit(1);
  }

  intro(`Connect ${DISPLAY_NAME[slug]}`);
  process.stdout.write(`${renderTosWarning(slug)}\n`);

  if (!opts.yes) {
    const ok = await confirm("I understand the risk and want to continue", false);
    if (!ok) {
      outro("Cancelled.");
      return;
    }
  }

  const label =
    opts.label ??
    (process.stdin.isTTY
      ? await askText("Connection label", DEFAULT_LABEL[slug])
      : DEFAULT_LABEL[slug]);

  try {
    const tokens = await runLoopbackOAuth(slug);
    const sp = spinner();
    sp.start("Saving connection on the platform…");
    const result = await apiFetch<ImportResponse>(
      profileName,
      "/api/model-providers-oauth/import",
      {
        method: "POST",
        body: JSON.stringify({
          providerPackageId,
          label,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt > 0 ? tokens.expiresAt : null,
          ...(profile.connectionProfileId
            ? { connectionProfileId: profile.connectionProfileId }
            : {}),
          ...(tokens.email ? { email: tokens.email } : {}),
          ...(tokens.subscriptionType ? { subscriptionType: tokens.subscriptionType } : {}),
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
        }),
      },
    );
    sp.stop("Connection saved.");

    const lines: string[] = [
      `Provider key id: ${result.providerKeyId}`,
      `Models available: ${result.availableModelIds.join(", ")}`,
    ];
    if (result.email) lines.push(`Account email:    ${result.email}`);
    if (result.subscriptionType) lines.push(`Subscription:     ${result.subscriptionType}`);
    process.stdout.write(`\n${lines.join("\n")}\n`);
    outro(`✓ ${DISPLAY_NAME[slug]} connected to "${label}".`);
  } catch (err) {
    exitWithError(err);
  }
}
