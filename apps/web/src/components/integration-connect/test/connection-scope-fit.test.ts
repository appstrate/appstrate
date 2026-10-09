// SPDX-License-Identifier: Apache-2.0

/**
 * How the connection picker reads a connection's grant against an agent: the
 * short scope summary, the exact / broader / missing verdict that orders the
 * menu, and the order itself. A "broader" false positive teaches users to
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
  it("lists the scopes beyond the auth's defaults first, then folds the rest into +N", () => {
    expect(summarizeScopes(MANIFEST, "oauth", ["openid", READ, SEND, LABELS])).toEqual({
      text: "Send · Labels +2",
      title: "Send, Labels, Identity, Read",
    });
  });

  it("shows a short set whole", () => {
    expect(summarizeScopes(MANIFEST, "oauth", [READ])).toEqual({ text: "Read", title: "Read" });
    expect(summarizeScopes(MANIFEST, "oauth", [])).toEqual({ text: "", title: "" });
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

  it("counts what a required scope implies as asked for", () => {
    expect(fit(["openid", MODIFY, SEND], [MODIFY])).toBe("exact");
  });

  it("is broader when the grant goes beyond the required scopes and the defaults", () => {
    expect(fit(["openid", READ, LABELS], [READ])).toBe("broader");
  });

  it("is broader when a granted parent covers a required child", () => {
    // `modify` covers `send` but also writes: more than the agent asked for.
    expect(fit(["openid", MODIFY], [SEND])).toBe("broader");
  });
});

describe("sortByScopeFit", () => {
  it("orders exact, then broader, then missing, keeping the given order within each", () => {
    const fits: Record<string, ScopeFit> = {
      a: "missing",
      b: "broader",
      c: "exact",
      d: "broader",
      e: "exact",
    };
    expect(sortByScopeFit(Object.keys(fits), (id) => fits[id]!)).toEqual(["c", "e", "b", "d", "a"]);
  });
});
