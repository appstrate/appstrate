// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/model-store.ts` — the two scopes of the chat model selection.
 *
 * The bug this pins: with ONE global value, reopening a conversation answered
 * by model A while the store held B continued it on B, silently. The stored
 * value is now the DEFAULT for a conversation with no transcript; the open
 * conversation's own transcript decides what it is on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getSelectedModel,
  seedConversationModel,
  setActiveConversation,
  setSelectedModel,
} from "../src/ui/model-store.ts";

beforeEach(() => {
  setActiveConversation(null);
  setSelectedModel(null);
});

afterEach(() => {
  setActiveConversation(null);
  setSelectedModel(null);
});

describe("the model a conversation is on", () => {
  it("is the seeded one, not the stored default", () => {
    setSelectedModel("default-model");
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "model-a");

    expect(getSelectedModel()).toBe("model-a");
  });

  it("falls back to the stored default for a conversation with no transcript", () => {
    setSelectedModel("default-model");
    setActiveConversation("chs_new");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("does not leak from one conversation into the next", () => {
    // The regression itself. Opening B after A must not continue on A's model.
    setSelectedModel("default-model");
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "model-a");
    expect(getSelectedModel()).toBe("model-a");

    setActiveConversation("chs_b");
    expect(getSelectedModel()).toBe("default-model");
  });
});

describe("seeding versus picking", () => {
  it("does not clobber a pick made while the history was in flight", () => {
    // The history GET resolves after the user has already changed the model.
    // The pick is newer than the transcript and wins.
    setActiveConversation("chs_a");
    setSelectedModel("picked");
    seedConversationModel("chs_a", "from-history");

    expect(getSelectedModel()).toBe("picked");
  });

  it("ignores a seed for a conversation the user has already left", () => {
    // Same late GET, but the user navigated away first: applying it would put
    // conversation A's model on conversation B.
    setSelectedModel("default-model");
    setActiveConversation("chs_a");
    setActiveConversation("chs_b");
    seedConversationModel("chs_a", "model-a");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("makes a pick the open conversation's model AND the next new chat's default", () => {
    setActiveConversation("chs_a");
    setSelectedModel("picked");
    expect(getSelectedModel()).toBe("picked");

    // A brand-new conversation has no transcript, so it starts on that pick.
    setActiveConversation("chs_new");
    expect(getSelectedModel()).toBe("picked");
  });

  it("lets a pick override a model already seeded from history", () => {
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "from-history");
    setSelectedModel("picked");

    expect(getSelectedModel()).toBe("picked");
  });
});
