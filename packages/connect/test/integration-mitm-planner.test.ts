// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the pure MITM action planner. Every branch is exercised
 * with hand-built {@link IntegrationCredentialsPayload} fixtures and an
 * inline {@link HttpDeliveryPlan} map — no manifest parsing, no
 * credential-resolver round-trip. The planner has no I/O so it should
 * be 100% deterministic.
 */

import { describe, it, expect } from "bun:test";
import { planMitmAction, type MitmRequestContext } from "../src/integration-mitm-planner.ts";
import type {
  HttpDeliveryPlan,
  IntegrationCredentialsPayload,
  ResolvedAuthCredentials,
} from "../src/integration-credentials.ts";

function auth(
  authKey: string,
  overrides: Partial<ResolvedAuthCredentials> = {},
): ResolvedAuthCredentials {
  return {
    authKey,
    authType: "oauth2",
    fields: Object.freeze({ access_token: `${authKey}-tok` }),
    authorizedUris: Object.freeze([`https://api.${authKey}.com/*`]),
    ...overrides,
  };
}

function payload(...auths: ResolvedAuthCredentials[]): IntegrationCredentialsPayload {
  return { auths };
}

const PLAIN_BEARER: HttpDeliveryPlan = {
  headerName: "Authorization",
  headerPrefix: "Bearer",
  value: "github-tok",
  allowServerOverride: false,
};

describe("planMitmAction — no auth matches", () => {
  it("strips the universal pair only; injects nothing; no retry", () => {
    const p = payload(auth("github"));
    const ctx: MitmRequestContext = {
      url: "https://elsewhere.example.com/x",
      headerNames: ["Content-Type", "Accept"],
      deliveryPlans: {},
    };
    const action = planMitmAction(ctx, p);
    expect(action.matchedAuth).toBeNull();
    expect(action.injectedHeader).toBeNull();
    expect(action.retry401).toBe(false);
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toEqual([
      "authorization",
      "proxy-authorization",
    ]);
  });

  it("strips the universal pair regardless of caller header casing", () => {
    const p = payload(auth("github"));
    const ctx: MitmRequestContext = {
      url: "https://elsewhere.example.com/x",
      headerNames: ["authorization", "PROXY-AUTHORIZATION"],
      deliveryPlans: {},
    };
    const action = planMitmAction(ctx, p);
    // The strip list is name-based and case-insensitive at the listener;
    // the planner just emits the canonical names.
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toEqual([
      "authorization",
      "proxy-authorization",
    ]);
  });
});

describe("planMitmAction — auth matches, default deny override", () => {
  it("matches first auth, injects Authorization: Bearer, retry oauth", () => {
    const a = auth("github");
    const ctx: MitmRequestContext = {
      url: "https://api.github.com/repos",
      headerNames: ["Authorization", "X-Custom"],
      deliveryPlans: { github: PLAIN_BEARER },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.matchedAuth?.authKey).toBe("github");
    expect(action.injectedHeader).toEqual({
      name: "Authorization",
      value: "Bearer github-tok",
    });
    expect(action.retry401).toBe(true);
    // Universal strip still includes Authorization since allowServerOverride is false.
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toContain("authorization");
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toContain("proxy-authorization");
  });

  it("strips the manifest headerName when it differs from Authorization", () => {
    const a: ResolvedAuthCredentials = {
      ...auth("acme"),
      authType: "api_key",
    };
    const plan: HttpDeliveryPlan = {
      headerName: "X-Api-Key",
      headerPrefix: "",
      value: "acme-secret",
      allowServerOverride: false,
    };
    const ctx: MitmRequestContext = {
      url: "https://api.acme.com/x",
      headerNames: ["Authorization", "X-Api-Key"],
      deliveryPlans: { acme: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toContain("x-api-key");
    expect(action.injectedHeader).toEqual({ name: "X-Api-Key", value: "acme-secret" });
    // api_key does not get a 401-retry; nothing to refresh.
    expect(action.retry401).toBe(false);
  });
});

describe("planMitmAction — allowServerOverride: true", () => {
  it("when override allowed AND caller set the header → injection skipped", () => {
    const plan: HttpDeliveryPlan = {
      ...PLAIN_BEARER,
      allowServerOverride: true,
    };
    const a = auth("github");
    const ctx: MitmRequestContext = {
      url: "https://api.github.com/x",
      headerNames: ["Authorization"],
      deliveryPlans: { github: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.injectedHeader).toBeNull();
    // Authorization dropped from strip set so caller's value survives.
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).not.toContain("authorization");
    // Proxy-Authorization always stays stripped (cross-auth boundary).
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toContain("proxy-authorization");
  });

  it("when override allowed AND caller did NOT set the header → injection still runs", () => {
    const plan: HttpDeliveryPlan = {
      ...PLAIN_BEARER,
      allowServerOverride: true,
    };
    const a = auth("github");
    const ctx: MitmRequestContext = {
      url: "https://api.github.com/x",
      headerNames: ["Content-Type"],
      deliveryPlans: { github: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.injectedHeader).toEqual({
      name: "Authorization",
      value: "Bearer github-tok",
    });
  });
});

describe("planMitmAction — empty delivery value", () => {
  it("returns injectedHeader: null when the resolver produced an empty value", () => {
    const plan: HttpDeliveryPlan = {
      ...PLAIN_BEARER,
      value: "",
    };
    const a = auth("github");
    const ctx: MitmRequestContext = {
      url: "https://api.github.com/x",
      headerNames: [],
      deliveryPlans: { github: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.injectedHeader).toBeNull();
    // Still strips so a leaked stale Bearer can't reach upstream.
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toContain("authorization");
  });

  it("does NOT strip a custom (non-Authorization) header when the value is empty", () => {
    // Run-start `connect.tool` login: the session isn't captured yet, so its
    // placeholder delivery plan carries `value: ""`. The login tool manages
    // its own cookie jar (CSRF + session cookies across the redirect chain) on
    // the SAME header name the session will later inject (`Cookie`). Stripping
    // it now would clobber the jar while protecting nothing — there is no
    // injected credential to shadow.
    const plan: HttpDeliveryPlan = {
      headerName: "Cookie",
      headerPrefix: "",
      value: "",
      allowServerOverride: false,
    };
    const a = auth("kijiji", { authType: "custom" });
    const ctx: MitmRequestContext = {
      url: "https://api.kijiji.com/login",
      headerNames: ["Cookie", "Content-Type"],
      deliveryPlans: { kijiji: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.injectedHeader).toBeNull();
    const lower = action.strippedHeaderNames.map((s) => s.toLowerCase());
    expect(lower).not.toContain("cookie");
    // The universal pair is still stripped regardless.
    expect(lower).toContain("authorization");
    expect(lower).toContain("proxy-authorization");
  });

  it("DOES strip the custom header once a non-empty value is present", () => {
    // After capture, the session has real cookies → injection + strip resume,
    // so the integration can no longer set its own `Cookie` to shadow ours.
    const plan: HttpDeliveryPlan = {
      headerName: "Cookie",
      headerPrefix: "",
      value: "kj-st=abc; kj-at=def",
      allowServerOverride: false,
    };
    const a = auth("kijiji", { authType: "custom" });
    const ctx: MitmRequestContext = {
      url: "https://api.kijiji.com/whoami",
      headerNames: ["Cookie"],
      deliveryPlans: { kijiji: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.injectedHeader).toEqual({ name: "Cookie", value: "kj-st=abc; kj-at=def" });
    expect(action.strippedHeaderNames.map((s) => s.toLowerCase())).toContain("cookie");
  });
});

describe("planMitmAction — no delivery plan for matched auth", () => {
  it("matches but injects nothing (custom auth that doesn't declare http delivery)", () => {
    const a: ResolvedAuthCredentials = {
      ...auth("vendor"),
      authType: "custom",
    };
    const ctx: MitmRequestContext = {
      url: "https://api.vendor.com/x",
      headerNames: [],
      deliveryPlans: {}, // No plan for `vendor`.
    };
    const action = planMitmAction(ctx, payload(a));
    expect(action.matchedAuth?.authKey).toBe("vendor");
    expect(action.injectedHeader).toBeNull();
    expect(action.retry401).toBe(false);
  });
});

describe("planMitmAction — retry401 per auth type", () => {
  it("oauth2 → retry401: true", () => {
    const a = auth("github", { authType: "oauth2" });
    const ctx: MitmRequestContext = {
      url: "https://api.github.com/x",
      headerNames: [],
      deliveryPlans: { github: PLAIN_BEARER },
    };
    expect(planMitmAction(ctx, payload(a)).retry401).toBe(true);
  });

  for (const t of ["api_key", "basic", "custom"]) {
    it(`${t} → retry401: false`, () => {
      const a: ResolvedAuthCredentials = {
        ...auth("vendor"),
        authType: t,
      };
      const plan: HttpDeliveryPlan = {
        headerName: "X-Api-Key",
        headerPrefix: "",
        value: "tok",
        allowServerOverride: false,
      };
      const ctx: MitmRequestContext = {
        url: "https://api.vendor.com/x",
        headerNames: [],
        deliveryPlans: { vendor: plan },
      };
      expect(planMitmAction(ctx, payload(a)).retry401).toBe(false);
    });
  }
});

describe("planMitmAction — dedup", () => {
  it("dedupes strip list case-insensitively when manifest header collides with universal pair", () => {
    const plan: HttpDeliveryPlan = {
      headerName: "AUTHORIZATION", // Same header, different casing.
      headerPrefix: "Bearer",
      value: "tok",
      allowServerOverride: false,
    };
    const a = auth("svc");
    const ctx: MitmRequestContext = {
      url: "https://api.svc.com/x",
      headerNames: [],
      deliveryPlans: { svc: plan },
    };
    const action = planMitmAction(ctx, payload(a));
    const lower = action.strippedHeaderNames.map((s) => s.toLowerCase());
    const auths = lower.filter((s) => s === "authorization");
    expect(auths.length).toBe(1);
  });
});
