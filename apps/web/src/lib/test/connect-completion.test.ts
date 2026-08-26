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
import { INTEGRATION_CONNECT_MESSAGE_TYPE } from "@appstrate/core/connect-handshake";
import { publishConnectCompletion } from "../connect-completion.ts";

const SELF = "https://app.appstrate.dev";

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
