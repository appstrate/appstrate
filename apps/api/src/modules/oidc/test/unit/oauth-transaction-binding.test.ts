// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure classification half of the OAuth transaction
 * binding (CRIT-15). `analyzeOAuthCallbackURL` decides whether a social
 * transaction's server-stored `callbackURL` marks the flow as
 * OIDC-initiated (→ realm derives from the bound client), incoherent
 * (→ fail closed), or positively non-OIDC (→ platform rules).
 */

import { describe, it, expect } from "bun:test";
import {
  analyzeOAuthCallbackURL,
  OAUTH_AUTHORIZE_PATHNAME,
} from "../../services/oauth-transaction-binding.ts";

describe("analyzeOAuthCallbackURL", () => {
  it("binds an absolute authorize callbackURL to its client_id", () => {
    const result = analyzeOAuthCallbackURL(
      `https://app.example.com${OAUTH_AUTHORIZE_PATHNAME}?client_id=oauth_abc123&redirect_uri=https%3A%2F%2Frp.example%2Fcb&state=xyz`,
    );
    expect(result).toEqual({ kind: "oidc", clientId: "oauth_abc123" });
  });

  it("binds a relative authorize callbackURL to its client_id", () => {
    const result = analyzeOAuthCallbackURL(
      `${OAUTH_AUTHORIZE_PATHNAME}?client_id=oauth_rel&scope=openid`,
    );
    expect(result).toEqual({ kind: "oidc", clientId: "oauth_rel" });
  });

  it("matches the authorize pathname behind a reverse-proxy prefix (suffix match)", () => {
    const result = analyzeOAuthCallbackURL(
      `https://edge.example.com/tenant-a${OAUTH_AUTHORIZE_PATHNAME}?client_id=oauth_pfx`,
    );
    expect(result).toEqual({ kind: "oidc", clientId: "oauth_pfx" });
  });

  it("fails closed on an authorize destination without client_id", () => {
    expect(analyzeOAuthCallbackURL(OAUTH_AUTHORIZE_PATHNAME)).toEqual({ kind: "invalid" });
    expect(analyzeOAuthCallbackURL(`${OAUTH_AUTHORIZE_PATHNAME}?scope=openid`)).toEqual({
      kind: "invalid",
    });
  });

  it("fails closed on an unparseable destination", () => {
    expect(analyzeOAuthCallbackURL("http://[")).toEqual({ kind: "invalid" });
  });

  it("classifies non-authorize destinations as positively non-OIDC", () => {
    expect(analyzeOAuthCallbackURL("/")).toEqual({ kind: "not-oidc" });
    expect(analyzeOAuthCallbackURL("https://app.example.com/")).toEqual({ kind: "not-oidc" });
    // A client_id on a non-authorize path is NOT an OIDC transaction marker.
    expect(analyzeOAuthCallbackURL("/dashboard?client_id=oauth_abc")).toEqual({
      kind: "not-oidc",
    });
    // Path must END with the authorize pathname — a lookalike prefix is not it.
    expect(
      analyzeOAuthCallbackURL(`${OAUTH_AUTHORIZE_PATHNAME}/extra?client_id=oauth_abc`),
    ).toEqual({ kind: "not-oidc" });
  });
});
