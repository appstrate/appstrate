// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/model-store.ts` — the two scopes of the chat model selection.
 *
 * The bug this pins: with ONE global value, reopening a conversation answered
 * by model A while the store held B continued it on B, silently. The stored
 * value is now the DEFAULT for a conversation with no transcript; the open
 * conversation's own transcript pre-selects what it is on — a pre-selection,
 * never a lock (the server runs each turn on the `X-Model-Id` it is sent).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelGenerationCapabilities } from "@appstrate/core/model-generation";
import {
  getCompatibleGenerationSettings,
  getGenerationSettings,
  getSelectedModel,
  seedConversationModel,
  setActiveConversation,
  setGenerationSettings,
  setModelCatalog,
  setSelectedModel,
} from "../src/ui/model-store.ts";

/** Every id the scope tests use, all live — they are about scopes, not liveness. */
const CATALOG = ["default-model", "model-a", "model-b", "picked", "from-history"].map((id) => ({
  id,
}));

const REASONING_HIGH: ModelGenerationCapabilities = {
  temperature: "supported",
  reasoning: { supported: "supported", adaptive: false, levels: { high: "supported" } },
};

const NO_REASONING: ModelGenerationCapabilities = {
  temperature: "supported",
  reasoning: { supported: "unsupported", adaptive: false, levels: {} },
};

function reset(): void {
  setActiveConversation(null);
  setModelCatalog(CATALOG);
  setSelectedModel(null);
  setGenerationSettings({});
}

beforeEach(reset);
afterEach(reset);

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

describe("a pre-selection is always a live model", () => {
  const catalog = [
    { id: "default-model", is_default: true },
    { id: "dead-model", needs_reconnection: true },
  ];

  it("never pre-selects a model the catalog no longer lists", () => {
    // Deleted or disabled since the conversation last ran: `/api/models` drops
    // it. Pre-selecting it would leave the picker blank and every send refused.
    setModelCatalog(catalog);
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "deleted-model");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("never pre-selects a listed model whose credential is dead", () => {
    setModelCatalog(catalog);
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "dead-model");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("drops a pre-selection the next catalog no longer serves live", () => {
    // The seed and the catalog load independently; whichever lands last, the
    // selection must end up live.
    setModelCatalog([...catalog, { id: "model-a" }]);
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "model-a");
    expect(getSelectedModel()).toBe("model-a");

    setModelCatalog(catalog);
    expect(getSelectedModel()).toBe("default-model");
  });

  it("keeps the user's own default when it drops a stale pre-selection", () => {
    // Falling back must not overwrite the stored preference with the org
    // default: the user's default is live, only the conversation's model is not.
    setModelCatalog([...catalog, { id: "model-b" }]);
    setSelectedModel("model-b");
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "deleted-model");

    expect(getSelectedModel()).toBe("model-b");
  });
});

describe("generation settings follow the model that is actually sent", () => {
  beforeEach(() => {
    setModelCatalog([
      { id: "default-model", is_default: true, generation: REASONING_HIGH },
      { id: "model-a", generation: NO_REASONING },
    ]);
    setSelectedModel("default-model");
    setGenerationSettings({ reasoningLevel: "high" });
  });

  it("reconciles against a pre-selected model, not the stored default", () => {
    // The default supports `high`, the reopened conversation's model has no
    // reasoning. Sending `high` with `X-Model-Id: model-a` is a 400.
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "model-a");

    expect(getSelectedModel()).toBe("model-a");
    expect(getCompatibleGenerationSettings()).toEqual({});
  });

  it("does not erase the default's preference by opening an old conversation", () => {
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "model-a");
    expect(getGenerationSettings()).toEqual({ reasoningLevel: "high" });

    setActiveConversation("chs_new");
    expect(getCompatibleGenerationSettings()).toEqual({ reasoningLevel: "high" });
  });

  it("returns a stable snapshot while nothing changed", () => {
    // It is a `useSyncExternalStore` snapshot: a fresh object per read loops.
    setActiveConversation("chs_a");
    seedConversationModel("chs_a", "model-a");

    expect(getCompatibleGenerationSettings()).toBe(getCompatibleGenerationSettings());
  });
});
