// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the provider-agnostic OAuth wire-format application
 * (sidecar/oauth-identity.ts):
 *
 *   - `buildIdentityHeaders` echoes `wireFormat.identityHeaders` and
 *     optionally an `accountId` routing header.
 *   - `transformBody` prepends `wireFormat.systemPrepend` to the body's
 *     `system` field across all input shapes (string / array / absent /
 *     already-prepended) and coerces `stream` / `store` flags.
 *   - `adaptHeaderForRetry` strips a configured token from the configured
 *     header when the upstream response matches the configured shape.
 *
 * Test data uses two synthetic wire-format fixtures (PREPEND, ACCOUNT_ID)
 * that exercise every code path without naming any real-world provider —
 * everything is driven by the declarative `OAuthWireFormat` struct.
 */

import { describe, it, expect } from "bun:test";
import type { OAuthWireFormat } from "@appstrate/core/sidecar-types";
import { buildIdentityHeaders, transformBody, adaptHeaderForRetry } from "../oauth-identity.ts";
import type { CachedToken } from "../oauth-token-cache.ts";

function makeToken(overrides: Partial<CachedToken> = {}): CachedToken {
  return {
    accessToken: "tok",
    expiresAt: Date.now() + 60_000,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

const PREPEND_TEXT = "synthetic-system-prelude";

const PREPEND_WIRE_FORMAT: OAuthWireFormat = {
  identityHeaders: {
    accept: "application/json",
    "x-app": "cli",
    "x-fingerprint": "synthetic",
  },
  systemPrepend: {
    type: "text",
    text: PREPEND_TEXT,
  },
  adaptiveRetry: {
    status: 400,
    bodyPatterns: ["out of extra usage", "long context beta not available"],
    headerName: "anthropic-beta",
    removeToken: "context-1m-2025-08-07",
  },
};

const ACCOUNT_ID_WIRE_FORMAT: OAuthWireFormat = {
  identityHeaders: {
    "x-originator": "pi",
    "x-feature-beta": "responses=experimental",
    "user-agent": "pi (linux x86_64)",
    accept: "text/event-stream",
  },
  accountIdHeader: "x-account-id",
};

describe("buildIdentityHeaders", () => {
  it("forwards identityHeaders from the wireFormat verbatim", () => {
    const h = buildIdentityHeaders(PREPEND_WIRE_FORMAT, makeToken());
    expect(h["accept"]).toBe("application/json");
    expect(h["x-app"]).toBe("cli");
    expect(h["x-fingerprint"]).toBe("synthetic");
  });

  it("echoes accountId via the configured header when set", () => {
    const h = buildIdentityHeaders(ACCOUNT_ID_WIRE_FORMAT, makeToken({ accountId: "acc_xyz" }));
    expect(h["x-originator"]).toBe("pi");
    expect(h["x-feature-beta"]).toBe("responses=experimental");
    expect(h["x-account-id"]).toBe("acc_xyz");
  });

  it("omits the accountId header when the token carries no accountId", () => {
    const h = buildIdentityHeaders(ACCOUNT_ID_WIRE_FORMAT, makeToken());
    expect(h["x-account-id"]).toBeUndefined();
    expect(h["x-originator"]).toBe("pi");
  });

  it("omits the accountId header when no accountIdHeader is configured", () => {
    const h = buildIdentityHeaders(PREPEND_WIRE_FORMAT, makeToken({ accountId: "acc_xyz" }));
    expect(h["x-account-id"]).toBeUndefined();
  });

  it("returns an empty object when wireFormat is undefined", () => {
    expect(buildIdentityHeaders(undefined, makeToken())).toEqual({});
  });

  it("returns an empty object when wireFormat has no fields", () => {
    expect(buildIdentityHeaders({}, makeToken({ accountId: "acc_xyz" }))).toEqual({});
  });
});

describe("transformBody — systemPrepend", () => {
  const IDENTITY = PREPEND_WIRE_FORMAT.systemPrepend!.text;

  it("prepends identity when system is absent", () => {
    const body = JSON.stringify({ model: "synthetic-model", messages: [] });
    const out = JSON.parse(transformBody(PREPEND_WIRE_FORMAT, body));
    expect(out.system).toEqual([{ type: "text", text: IDENTITY }]);
  });

  it("wraps a string system value into an array with identity first", () => {
    const body = JSON.stringify({ system: "You are a helpful assistant.", model: "x" });
    const out = JSON.parse(transformBody(PREPEND_WIRE_FORMAT, body));
    expect(out.system).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "You are a helpful assistant." },
    ]);
  });

  it("collapses an identical-string system to a single identity block", () => {
    const body = JSON.stringify({ system: IDENTITY });
    const out = JSON.parse(transformBody(PREPEND_WIRE_FORMAT, body));
    expect(out.system).toEqual([{ type: "text", text: IDENTITY }]);
  });

  it("prepends identity to an existing array of system blocks", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "first existing" }],
    });
    const out = JSON.parse(transformBody(PREPEND_WIRE_FORMAT, body));
    expect(out.system).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "first existing" },
    ]);
  });

  it("does not double-prepend if identity is already first", () => {
    const body = JSON.stringify({
      system: [
        { type: "text", text: IDENTITY },
        { type: "text", text: "extra" },
      ],
    });
    const out = JSON.parse(transformBody(PREPEND_WIRE_FORMAT, body));
    expect(out.system).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "extra" },
    ]);
  });
});

describe("transformBody — stream/store coercion", () => {
  it("forces stream and store flags when set", () => {
    const body = JSON.stringify({ model: "synthetic-model", stream: false, store: true });
    const out = JSON.parse(
      transformBody(ACCOUNT_ID_WIRE_FORMAT, body, { forceStream: true, forceStore: false }),
    );
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
  });

  it("leaves flags untouched when options are not provided", () => {
    const body = JSON.stringify({ model: "synthetic-model", stream: false, store: true });
    const out = JSON.parse(transformBody(ACCOUNT_ID_WIRE_FORMAT, body));
    expect(out.stream).toBe(false);
    expect(out.store).toBe(true);
  });
});

describe("transformBody — defensive paths", () => {
  it("returns input unchanged for empty body", () => {
    expect(transformBody(PREPEND_WIRE_FORMAT, "")).toBe("");
  });

  it("returns input unchanged when body is not JSON and a transform is requested", () => {
    expect(transformBody(PREPEND_WIRE_FORMAT, "not-json")).toBe("not-json");
  });

  it("returns input unchanged when wireFormat has no transform fields", () => {
    const body = JSON.stringify({ system: "x" });
    expect(transformBody(ACCOUNT_ID_WIRE_FORMAT, body)).toBe(body);
  });

  it("returns input unchanged when wireFormat is undefined", () => {
    const body = JSON.stringify({ system: "x" });
    expect(transformBody(undefined, body)).toBe(body);
  });
});

describe("adaptHeaderForRetry", () => {
  const policy = PREPEND_WIRE_FORMAT.adaptiveRetry!;

  it("returns null when no policy is configured", () => {
    expect(
      adaptHeaderForRetry(undefined, 400, "out of extra usage", {
        "anthropic-beta": "context-1m-2025-08-07",
      }),
    ).toBeNull();
  });

  it("returns null when status doesn't match the policy", () => {
    expect(
      adaptHeaderForRetry(policy, 429, "out of extra usage", {
        "anthropic-beta": "context-1m-2025-08-07",
      }),
    ).toBeNull();
  });

  it("returns null when body doesn't match the configured patterns", () => {
    expect(
      adaptHeaderForRetry(policy, 400, "some other error", {
        "anthropic-beta": "context-1m-2025-08-07",
      }),
    ).toBeNull();
  });

  it("returns null when the configured header is absent", () => {
    expect(adaptHeaderForRetry(policy, 400, "out of extra usage", {})).toBeNull();
  });

  it("returns null when the configured token is not present in the header", () => {
    expect(
      adaptHeaderForRetry(policy, 400, "out of extra usage", {
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      }),
    ).toBeNull();
  });

  it("strips the token and preserves other entries", () => {
    const out = adaptHeaderForRetry(policy, 400, "out of extra usage", {
      "anthropic-beta": "context-1m-2025-08-07, other-beta-2025-01-01",
    });
    expect(out?.headers["anthropic-beta"]).toBe("other-beta-2025-01-01");
  });

  it("removes the header entirely when the stripped token was the only entry", () => {
    const out = adaptHeaderForRetry(policy, 400, "out of extra usage", {
      "anthropic-beta": "context-1m-2025-08-07",
    });
    expect(out?.headers["anthropic-beta"]).toBeUndefined();
  });

  it("matches case-insensitive header keys", () => {
    const out = adaptHeaderForRetry(policy, 400, "long context beta not available", {
      "Anthropic-Beta": "context-1m-2025-08-07, other",
    });
    expect(out?.headers["Anthropic-Beta"]).toBe("other");
  });
});
