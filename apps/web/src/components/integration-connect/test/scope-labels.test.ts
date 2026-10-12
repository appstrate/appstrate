// SPDX-License-Identifier: Apache-2.0

/**
 * How the connection picker words a connection's grant: its scope labels and
 * the short scope summary.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifestView } from "../../../hooks/use-integrations";
import { scopeLabels, summarizeScopes } from "../scope-labels";

const READ = "mail.read";
const SEND = "mail.send";
const MODIFY = "mail.modify";
const LABELS = "mail.labels";

const MANIFEST = {
  auths: {
    oauth: {
      type: "oauth2",
      default_scopes: ["openid", READ],
      scope_catalog: [
        { value: "openid", label: "Identity" },
        { value: READ, label: "Read" },
        { value: SEND, label: "Send" },
        { value: MODIFY, label: "Read & write", implies: [READ, SEND] },
        { value: LABELS, label: "Labels" },
      ],
    },
  },
} as unknown as IntegrationManifestView;

describe("scopeLabels", () => {
  it("names each scope by its catalog label, and by itself when the catalog lacks it", () => {
    expect(scopeLabels(MANIFEST, "oauth", [SEND, "custom.scope"])).toEqual([
      "Send",
      "custom.scope",
    ]);
  });

  it("falls back to the raw scopes without a manifest or an auth", () => {
    expect(scopeLabels(undefined, "oauth", [SEND])).toEqual([SEND]);
    expect(scopeLabels(MANIFEST, "other", [SEND])).toEqual([SEND]);
  });
});

describe("summarizeScopes", () => {
  const summary = (scopes: string[]) => summarizeScopes(MANIFEST, "oauth", scopes);

  it("names the defaults alone as such: no text", () => {
    expect(summary(["openid", READ, "email"])).toBeNull();
  });

  it("lists the held labels, non-default first, folding the rest into +N", () => {
    expect(summary(["openid", READ, SEND, LABELS, MODIFY])).toBe("Send · Labels +3");
  });

  it("leaves out what the catalog does not declare, the IdP's echo", () => {
    expect(summary(["openid", "profile", READ, SEND])).toBe("Send · Identity +1");
  });

  it("never reports a default the IdP did not echo as missing, nor passes the grant off as the defaults", () => {
    // `Read` absent: an unechoed pseudo-scope looks the same as one unticked at consent.
    expect(summary(["openid", "email"])).toBe("Identity");
  });

  it("holds a default through a granted scope that implies it", () => {
    expect(summary(["openid", MODIFY])).toBe("Read & write · Identity");
  });

  it("falls back to the raw grant when the catalog declares none of it", () => {
    expect(summary(["profile"])).toBe("profile");
  });

  it("keeps every scope, raw, when the auth declares no catalog", () => {
    expect(summarizeScopes(undefined, "oauth", ["a", "b"])).toBe("a · b");
  });
});
