// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted credential form's half of the connect handshake.
 *
 * It posted its completion to `targetOrigin: "*"` under a comment claiming that
 * matched the OAuth callback page — which scopes the same message to the
 * platform origin. The two halves of one handshake behaved oppositely, and the
 * wildcard bought nothing: every listener for this message is platform code
 * served from the platform's own origin (there is no cross-origin receiver in
 * the tree), so a wide `targetOrigin` was exposure with no capability behind
 * it. `state` + `packageId` ride in this payload.
 *
 * No DOM here, which is why `publishConnectCompletion` takes the opener and the
 * page origin as arguments instead of reading `window`.
 */

import { describe, it, expect } from "bun:test";
import {
  INTEGRATION_CONNECT_MESSAGE_TYPE,
  completionMatches,
} from "@appstrate/core/connect-handshake";
import {
  acceptsConnectHeldOpenMessage,
  connectHeldOpenMatches,
  publishConnectCompletion,
  publishConnectHeldOpen,
} from "../connect-completion.ts";

const SELF = "https://app.appstrate.dev";
const SSH = "@appstrate/ssh";

/** A stand-in `window.opener` that records what it was posted, and where. */
function recordingOpener(): { calls: Array<{ message: unknown; targetOrigin: string }> } & Window {
  const calls: Array<{ message: unknown; targetOrigin: string }> = [];
  return {
    calls,
    postMessage: (message: unknown, targetOrigin: string) => {
      calls.push({ message, targetOrigin });
    },
  } as unknown as { calls: Array<{ message: unknown; targetOrigin: string }> } & Window;
}

describe("publishConnectCompletion", () => {
  it("scopes the opener postMessage to the page's own origin, never '*'", () => {
    const opener = recordingOpener();
    publishConnectCompletion({ ok: true, packageId: "@appstrate/gmail" }, opener, SELF);

    expect(opener.calls).toHaveLength(1);
    expect(opener.calls[0]!.targetOrigin).not.toBe("*");
    expect(opener.calls[0]!.targetOrigin).toBe(SELF);
  });

  it("normalises a page URL carrying a path down to its origin", () => {
    // `postMessage` compares origins, but the sent string must match what the
    // API half sends from `APP_URL` so the two are auditably identical.
    const opener = recordingOpener();
    publishConnectCompletion({ ok: true }, opener, `${SELF}/connect?token=abc`);

    expect(opener.calls[0]!.targetOrigin).toBe(SELF);
  });

  it("stamps the shared message type onto the payload", () => {
    const opener = recordingOpener();
    publishConnectCompletion({ ok: true, packageId: "@appstrate/gmail" }, opener, SELF);

    expect(opener.calls[0]!.message).toEqual({
      type: INTEGRATION_CONNECT_MESSAGE_TYPE,
      ok: true,
      packageId: "@appstrate/gmail",
    });
  });

  it("survives a missing opener (full-tab completion) and still broadcasts", () => {
    expect(() => publishConnectCompletion({ ok: true }, null, SELF)).not.toThrow();
  });
});

/**
 * The second signal: "the connection exists, this window is staying open".
 *
 * A minted credential ends on an install block the user runs on another
 * machine, so that screen withholds its completion until they say they ran it —
 * longer than the opener's deadline, which would otherwise force the window
 * closed and report a timeout on a connection that exists. This kind disarms
 * the deadline and settles nothing, which is why it is a kind of its own.
 */
describe("publishConnectHeldOpen", () => {
  it("emits the held-open payload, scoped to the page's own origin", () => {
    const opener = recordingOpener();
    publishConnectHeldOpen({ packageId: SSH }, opener, SELF);

    expect(opener.calls).toHaveLength(1);
    expect(opener.calls[0]!.targetOrigin).toBe(SELF);
    expect(opener.calls[0]!.message).toEqual({
      type: "appstrate:integration_connect_held_open",
      packageId: SSH,
    });
  });

  it("is not a completion, so nothing waiting for one acts on it", () => {
    const opener = recordingOpener();
    publishConnectHeldOpen({ packageId: SSH }, opener, SELF);

    expect(completionMatches(opener.calls[0]!.message, { packageId: SSH })).toBe(false);
  });
});

describe("connectHeldOpenMatches", () => {
  const held = { type: "appstrate:integration_connect_held_open", packageId: SSH };

  it("accepts a held-open naming the integration being waited on", () => {
    expect(connectHeldOpenMatches(held, { packageId: SSH })).toBe(true);
  });

  it("refuses one naming another integration", () => {
    // Both carriers fan out, so another integration's signal must not disarm a
    // deadline this one is counting on.
    expect(connectHeldOpenMatches(held, { packageId: "@appstrate/gmail" })).toBe(false);
  });

  it("refuses a completion, whatever it says", () => {
    const completion = { type: INTEGRATION_CONNECT_MESSAGE_TYPE, ok: true, packageId: SSH };
    expect(connectHeldOpenMatches(completion, { packageId: SSH })).toBe(false);
  });
});

describe("acceptsConnectHeldOpenMessage", () => {
  const event = (origin: string) => ({
    origin,
    data: { type: "appstrate:integration_connect_held_open", packageId: SSH },
  });

  it("accepts one sent from the page's own origin", () => {
    expect(acceptsConnectHeldOpenMessage(event(SELF), SELF, { packageId: SSH })).toBe(true);
  });

  it("refuses a foreign origin", () => {
    const forged = event("https://evil.example");
    expect(acceptsConnectHeldOpenMessage(forged, SELF, { packageId: SSH })).toBe(false);
  });

  it("refuses an opaque origin on either side", () => {
    // `"null"` is what every sandboxed document reports and what `about:`,
    // `data:` and `blob:null` serialise to — it identifies nobody, so matching
    // two of them against each other would accept a forgery.
    expect(acceptsConnectHeldOpenMessage(event("null"), SELF, { packageId: SSH })).toBe(false);
    expect(acceptsConnectHeldOpenMessage(event("null"), "null", { packageId: SSH })).toBe(false);
  });
});
