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
  it("shows what the grant adds to the defaults, folding the rest into +N", () => {
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", READ, SEND, LABELS, MODIFY])).toEqual({
      text: "Send · Labels +1",
      lacking: null,
      title: "Identity, Read, Send, Labels, Read & write",
    });
  });

  it("leaves out what the catalog does not declare, the IdP's echo", () => {
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", "profile", READ, SEND])).toEqual({
      text: "Send",
      lacking: null,
      title: "Identity, profile, Read, Send",
    });
  });

  it("names the defaults a grant lacks, so a short grant never reads as the defaults", () => {
    // Read unticked at consent.
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", "email"])).toEqual({
      text: null,
      lacking: "Read",
      title: "Identity, email",
    });
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", SEND])?.lacking).toBe("Read");
  });

  it("holds a default through a granted scope that implies it", () => {
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", MODIFY])).toEqual({
      text: "Read & write",
      lacking: null,
      title: "Identity, Read & write",
    });
  });

  it("has neither text nor lack for the defaults alone, and nothing for an empty grant", () => {
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", READ, "email"])).toEqual({
      text: null,
      lacking: null,
      title: "Identity, Read, email",
    });
    expect(summarizeScopes(MANIFEST, "oauth", [])).toBeNull();
  });

  it("keeps every non-default scope, raw, when the auth declares no catalog", () => {
    expect(summarizeScopes(undefined, "oauth", ["a", "b"])).toEqual({
      text: "a · b",
      lacking: null,
      title: "a, b",
    });
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
