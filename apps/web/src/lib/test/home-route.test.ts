// SPDX-License-Identifier: Apache-2.0

/** `/` for a role with and without the Studio. */

import { describe, expect, it } from "bun:test";
import { homeOf } from "../home-route.ts";

describe("homeOf", () => {
  it("draws the dashboard wherever the Studio opens, before the rest is known", () => {
    expect(homeOf({ ready: false, studio: true, chat: false })).toBe("dashboard");
    expect(homeOf({ ready: true, studio: true, chat: true })).toBe("dashboard");
  });

  it("waits for the grants before sending a role elsewhere", () => {
    expect(homeOf({ ready: false, studio: false, chat: false })).toBe("pending");
  });

  it("opens the chat for a role without the Studio, and refuses a role with neither", () => {
    expect(homeOf({ ready: true, studio: false, chat: true })).toBe("chat");
    expect(homeOf({ ready: true, studio: false, chat: false })).toBe("denied");
  });
});
