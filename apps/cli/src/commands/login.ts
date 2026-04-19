// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate login` — interactive device-flow sign-in.
 *
 * Flow:
 *   1. Resolve profile name (flag → env → default).
 *   2. Ask for instance URL if not passed via `--instance`.
 *   3. POST /api/auth/device/code → receive user_code + verification URL.
 *   4. Print the code in the terminal + open the browser.
 *   5. Poll /api/auth/device/token until approval.
 *   6. Store the JWT access + rotating refresh pair in the keyring
 *      (issue #165); decode `sub` + `email` from the JWT payload
 *      (via `lib/jwt-identity.ts`) to capture userId + email;
 *      persist the profile in config.toml.
 */

import open from "open";
import { intro, outro, askText, spinner, formatUserCode, exitWithError } from "../lib/ui.ts";
import { readConfig, resolveProfileName, setProfile } from "../lib/config.ts";
import { saveTokens } from "../lib/keyring.ts";
import { startDeviceFlow, pollDeviceFlow } from "../lib/device-flow.ts";
import { normalizeInstance } from "../lib/instance-url.ts";
import { CLI_CLIENT_ID, CLI_SCOPE } from "../lib/cli-client.ts";
import { decodeAccessTokenIdentity } from "../lib/jwt-identity.ts";

export interface LoginOptions {
  profile?: string;
  instance?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);

  intro(`Appstrate login — profile "${profileName}"`);

  const rawInstance =
    opts.instance ??
    (await askText(
      "Instance URL",
      config.profiles[profileName]?.instance ?? "http://localhost:3000",
    ));

  // Validate + strip trailing `/` up front. Throws `InsecureInstanceError`
  // if the user pointed at a non-loopback `http://` host without
  // `--insecure` / `APPSTRATE_INSECURE=1` — we surface that via
  // `exitWithError` like any other terminal failure below.
  let normalizedInstance: string;
  try {
    normalizedInstance = normalizeInstance(rawInstance);
  } catch (err) {
    exitWithError(err);
  }

  try {
    await runLogin(profileName, normalizedInstance);
  } catch (err) {
    exitWithError(err);
  }
}

async function runLogin(profileName: string, instance: string): Promise<void> {
  // Step 1 — device code.
  const s = spinner();
  s.start("Requesting device code");
  const code = await startDeviceFlow(instance, CLI_CLIENT_ID, CLI_SCOPE);
  s.stop(`Code received — expires in ${Math.round(code.expiresIn / 60)}m`);

  const display = formatUserCode(code.userCode);

  // Step 2 — show the user what to do. Print outside the spinner so the
  // code remains visible even after the spinner rewinds the cursor.
  process.stdout.write(`\n  Visit: ${code.verificationUri}\n`);
  process.stdout.write(`  Code:  ${display}\n\n`);

  // Step 3 — open the browser on the complete URI (pre-fills user_code).
  // If `open` fails (headless SSH / no display), the printed URL + code
  // above keep the flow usable. Swallow the error silently.
  open(code.verificationUriComplete).catch(() => {});

  // Step 4 — poll until approval or terminal error.
  const pollSpinner = spinner();
  pollSpinner.start("Waiting for approval in your browser");
  const token = await pollDeviceFlow(instance, code.deviceCode, CLI_CLIENT_ID, {
    interval: code.interval,
    expiresIn: code.expiresIn,
  });
  pollSpinner.stop("Approved");

  // Step 5 — extract identity from the access token claims. The JWT
  // minted by /api/auth/cli/token carries `sub` (BA user id), `email`,
  // and `name` — everything the CLI needs to persist the profile. We
  // decode locally (base64url payload, no signature verification) because
  // the token was just obtained from an instance the user chose;
  // verification happens on every server request anyway. Decoding
  // locally also avoids the bootstrap problem: BA's /get-session only
  // reads session cookies, and /api/auth/* bypasses our OIDC bearer
  // strategy, so there is no endpoint that understands this JWT before
  // we have persisted org context.
  const identity = decodeAccessTokenIdentity(token.accessToken);

  // Step 6 — persist both the tokens and the profile in one pass.
  //
  // Issue #165: a 2.x server MUST issue both `refresh_token` and
  // `refresh_expires_in`. A missing `refresh_token` means pre-2.x;
  // a missing `refresh_expires_in` means a non-conforming proxy
  // stripped the field. Either way the CLI refuses the login rather
  // than fabricating an expiry — a hallucinated 30-day window would
  // mask a real protocol mismatch and leak into the keyring.
  if (!token.refreshToken) {
    throw new Error(
      "Server did not issue a refresh token — the instance may be running a pre-2.x Appstrate. " +
        "Upgrade the server, or use `--instance` to target a 2.x instance.",
    );
  }
  if (token.refreshExpiresIn === undefined) {
    throw new Error(
      "Server returned a refresh token without refresh_expires_in — the response is non-conforming. " +
        "Check the server version and any middleware transforming the /api/auth/cli/token response, then retry.",
    );
  }
  await saveTokens(profileName, {
    accessToken: token.accessToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    refreshToken: token.refreshToken,
    refreshExpiresAt: Date.now() + token.refreshExpiresIn * 1000,
  });
  await setProfile(profileName, {
    instance,
    userId: identity.userId,
    email: identity.email,
  });

  outro(`Logged in as ${identity.email}`);
}
