// SPDX-License-Identifier: Apache-2.0

/** `/` for a role with and without the chat or the Studio. */

import { describe, expect, it } from "bun:test";
import { homeOf, homeProduct } from "../home-route.ts";

describe("homeOf", () => {
  it("opens the chat first wherever it is the reader's, with or without the Studio", () => {
    expect(homeOf({ ready: true, studio: true, chat: true })).toBe("chat");
    expect(homeOf({ ready: true, studio: false, chat: true })).toBe("chat");
  });

  it("waits until the chat is decided, even where the Studio opens", () => {
    expect(homeOf({ ready: false, studio: false, chat: undefined })).toBe("pending");
    expect(homeOf({ ready: true, studio: true, chat: undefined })).toBe("pending");
  });

  it("opens the dashboard where the chat is not the reader's and the Studio opens", () => {
    expect(homeOf({ ready: true, studio: true, chat: false })).toBe("dashboard");
  });

  it("does not refuse before the grants are known", () => {
    expect(homeOf({ ready: false, studio: false, chat: false })).toBe("pending");
  });

  it("refuses a role with neither the Studio nor the chat", () => {
    expect(homeOf({ ready: true, studio: false, chat: false })).toBe("denied");
  });
});

describe("homeProduct", () => {
  it("frames `/` as the chat while it leads there, or may still where the instance loads it", () => {
    expect(homeProduct("chat", true)).toBe("chat");
    expect(homeProduct("pending", true)).toBe("chat");
  });

  it("frames it as the Studio otherwise", () => {
    expect(homeProduct("pending", false)).toBe("studio");
    expect(homeProduct("dashboard", true)).toBe("studio");
    expect(homeProduct("denied", true)).toBe("studio");
  });
});
