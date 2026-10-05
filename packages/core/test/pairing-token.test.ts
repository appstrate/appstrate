// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { decodePairingToken, encodePairingToken } from "../src/pairing-token.ts";

const SECRET = "a".repeat(43);

function roundTrip(platformUrl: string): string {
  const token = encodePairingToken({ platformUrl, providerId: "claude-code" }, SECRET);
  return decodePairingToken(token).platformUrl;
}

describe("pairing token platform URL", () => {
  it("accepts HTTPS anywhere and plain HTTP on loopback", () => {
    for (const url of [
      "https://app.appstrate.dev",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      // RFC 6761: every `*.localhost` name is loopback (per-worktree dev hosts).
      "http://chat-tool-approval.localhost:3400",
    ]) {
      expect(roundTrip(url)).toBe(url);
    }
  });

  it("refuses plain HTTP to anything that is not loopback", () => {
    for (const url of [
      "http://app.appstrate.dev",
      "http://localhost.example.com",
      "http://evil-localhost:3000",
    ]) {
      expect(() =>
        encodePairingToken({ platformUrl: url, providerId: "claude-code" }, SECRET),
      ).toThrow(/HTTPS or loopback/);
    }
  });
});
