// SPDX-License-Identifier: Apache-2.0

/**
 * How the connection picker reads a connection's grant against an agent: the
 * short scope summary, the fit verdict that orders the menu, and the order
 * itself. A "broader" false positive teaches users to
 * ignore the mark; a false "exact" hides a connection that would hand an agent
 * more than it asked for.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifestView } from "../../../hooks/use-integrations";
import {
  scopeFit,
  scopeLabels,
  sortByScopeFit,
  summarizeScopes,
  type ScopeFit,
} from "../connection-scope-fit";

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

describe("scopeFit", () => {
  const fit = (granted: string[], required: string[], missing: string[] = []) =>
    scopeFit({ manifest: MANIFEST, authKey: "oauth", granted, missing, required });

  it("is missing whenever the server reports missing scopes", () => {
    expect(fit(["openid", READ], [READ, SEND], [SEND])).toBe("missing");
  });

  it("is exact when the grant stays within the required scopes and the defaults", () => {
    expect(fit(["openid", READ, SEND], [SEND])).toBe("exact");
    expect(fit(["openid", READ], [])).toBe("exact");
  });

  it("is exact for an empty grant that covers the agent", () => {
    expect(fit([], [])).toBe("exact");
  });

  it("counts what a required scope implies as asked for", () => {
    expect(fit(["openid", MODIFY, SEND], [MODIFY])).toBe("exact");
  });

  it("ignores what the catalog does not declare: the IdP's echo grants nothing", () => {
    // Microsoft echoes `openid profile email` beside the requested scopes.
    expect(fit(["openid", "profile", "email", READ], [READ])).toBe("exact");
  });

  it("is broader when the grant goes beyond the required scopes and the defaults", () => {
    expect(fit(["openid", READ, LABELS], [READ])).toBe("broader");
  });

  it("is broader when a granted parent covers a required child", () => {
    // `modify` covers `send` but also writes: more than the agent asked for.
    expect(fit(["openid", MODIFY], [SEND])).toBe("broader");
  });

  it("passes no breadth judgement on a non-oauth2 auth, or an oauth2 one with no catalog", () => {
    const manifest = {
      auths: {
        key: { type: "api_key" },
        bare: { type: "oauth2", default_scopes: ["read"] },
      },
    } as unknown as IntegrationManifestView;
    const judge = (authKey: string, granted: string[]) =>
      scopeFit({ manifest, authKey, granted, missing: [], required: [] });
    expect(judge("key", [])).toBe("unjudged");
    expect(judge("bare", ["read", "write"])).toBe("unjudged");
  });
});

describe("sortByScopeFit", () => {
  it("orders exact, unjudged, broader, then missing, keeping the order within each", () => {
    const fits: Record<string, ScopeFit> = {
      a: "missing",
      b: "broader",
      c: "exact",
      u: "unjudged",
      d: "broader",
      e: "exact",
    };
    expect(sortByScopeFit(Object.keys(fits), (id) => fits[id]!)).toEqual([
      "c",
      "e",
      "u",
      "b",
      "d",
      "a",
    ]);
  });
});
