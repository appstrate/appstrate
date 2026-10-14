// SPDX-License-Identifier: Apache-2.0

/**
 * What the pairing body renders for a pairing already in flight, per state of
 * its poll. Effects never run in a static render, so nothing here mints: a
 * command on screen is the resumed one.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { $api, type paths } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { render } from "../../test/render.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { addPendingPairing, removePendingPairing } from "../../stores/pairing-store.ts";
import { OAuthPairingBody } from "../oauth-pairing-body.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

type PairingStatus =
  paths["/api/model-providers-oauth/pairing/{id}"]["get"]["responses"][200]["content"]["application/json"];

const PAIRING_ID = "pair_1";
const COMMAND = "npx @appstrate/connect-helper pairing-token";
const EXPIRES_AT = new Date(Date.now() + 5 * 60_000).toISOString();
const STATUS_KEY = $api.queryOptions("get", "/api/model-providers-oauth/pairing/{id}", {
  params: { path: { id: PAIRING_ID } },
}).queryKey;

const WAITING = settingsFr["credentials.oauth.cliWaiting"];
const GENERATING = settingsFr["credentials.oauth.generatingCommand"];
const EXPIRED = settingsFr["credentials.oauth.pairingExpired"];
const FAILED = settingsFr["credentials.oauth.pairingFailed"];
const REGENERATE = settingsFr["credentials.oauth.regenerateCommand"];

/**
 * The body of a new `codex` organization subscription, its poll in `poll`'s
 * state. SSR reads Zustand's hydration snapshot, not its live state.
 */
function renderBody(poll?: PairingStatus["status"] | Error): string {
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: "org_a",
  });
  const qc = new QueryClient();
  if (poll instanceof Error) {
    const query = qc.getQueryCache().build(qc, { queryKey: STATUS_KEY });
    query.setState({ ...query.state, status: "error", error: poll, fetchStatus: "idle" });
  } else if (poll) {
    const status: PairingStatus = {
      id: PAIRING_ID,
      status: poll,
      consumed_at: null,
      expiresAt: EXPIRES_AT,
      credentialId: null,
    };
    qc.setQueryData(STATUS_KEY, status);
  }
  try {
    return render(<OAuthPairingBody providerId="codex" target={{ ownerType: "org" }} />, {
      queryClient: qc,
    });
  } finally {
    orgSnapshot.mockRestore();
  }
}

describe("OAuthPairingBody", () => {
  beforeEach(() => {
    addPendingPairing(
      {
        id: PAIRING_ID,
        providerId: "codex",
        target: { ownerType: "org" },
        expiresAt: EXPIRES_AT,
        orgId: "org_a",
      },
      COMMAND,
    );
  });

  afterEach(() => removePendingPairing(PAIRING_ID));

  it("shows the command of the pairing in flight instead of generating one", () => {
    const html = renderBody();
    expect(html).toContain(COMMAND);
    expect(html).toContain(WAITING);
    expect(html).not.toContain(GENERATING);
  });

  it("generates a command when no pairing is in flight", () => {
    removePendingPairing(PAIRING_ID);
    const html = renderBody();
    expect(html).toContain(GENERATING);
    expect(html).not.toContain(COMMAND);
  });

  it("states a refused redeem inline and offers a new command", () => {
    const html = renderBody("failed");
    expect(html).toContain(FAILED);
    expect(html).toContain(REGENERATE);
    expect(html).not.toContain(COMMAND);
  });

  it("states an expired pairing", () => {
    expect(renderBody("expired")).toContain(EXPIRED);
  });

  it("states a pairing the server does not state as expired", () => {
    expect(renderBody(new ApiError("not_found", "Pairing not found", 404))).toContain(EXPIRED);
  });
});
