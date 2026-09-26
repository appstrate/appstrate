// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/model-store.ts` — the chat model selection and the generation
 * settings sent with it.
 *
 * Two scopes: the stored value is the DEFAULT for a conversation with no
 * transcript; the open conversation's own transcript pre-selects what it is on
 * — a pre-selection, never a lock (the server runs each turn on the
 * `X-Model-Id` it is sent). The stored generation preference is observed
 * through `getCompatibleGenerationSettings` on a model that accepts all of it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelGenerationCapabilities } from "@appstrate/core/model-generation";
import {
  attachConversation,
  editGenerationSettings,
  getCompatibleGenerationSettings,
  getSelectedModel,
  hasOwnCredentialModel,
  setModelCatalog,
  setSelectedModel,
  subscribeModel,
} from "../src/ui/model-store.ts";

const REASONING_HIGH: ModelGenerationCapabilities = {
  temperature: "supported",
  reasoning: { supported: "supported", adaptive: false, levels: { high: "supported" } },
};

const NO_REASONING: ModelGenerationCapabilities = {
  temperature: "supported",
  reasoning: { supported: "unsupported", adaptive: false, levels: {} },
};

const NO_TEMPERATURE: ModelGenerationCapabilities = {
  ...REASONING_HIGH,
  temperature: "unsupported",
};

/** Every id the scope tests use, all live — they are about scopes, not liveness. */
const CATALOG = ["default-model", "model-a", "model-b", "picked", "from-history"].map((id) => ({
  id,
}));

function reset(): void {
  attachConversation(null, null);
  // Clearing the preference goes through the picker's own edit, on a model
  // that shows every key, so nothing survives as a hidden one.
  setModelCatalog([{ id: "reset", generation: REASONING_HIGH }]);
  setSelectedModel("reset");
  editGenerationSettings({});
  setModelCatalog(CATALOG);
  setSelectedModel(null);
}

beforeEach(reset);
afterEach(reset);

describe("the model a conversation is on", () => {
  it("is the seeded one, not the stored default", () => {
    setSelectedModel("default-model");
    attachConversation("chs_a", "model-a");

    expect(getSelectedModel()).toBe("model-a");
  });

  it("falls back to the stored default for a conversation with no transcript", () => {
    setSelectedModel("default-model");
    attachConversation("chs_new", null);

    expect(getSelectedModel()).toBe("default-model");
  });

  it("does not leak from one conversation into the next", () => {
    setSelectedModel("default-model");
    attachConversation("chs_a", "model-a");
    expect(getSelectedModel()).toBe("model-a");

    attachConversation("chs_b", null);
    expect(getSelectedModel()).toBe("default-model");
  });

  it("is never seeded while no conversation is attached", () => {
    setSelectedModel("default-model");
    attachConversation(null, "model-a");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("re-seeds a conversation reopened after being left", () => {
    // Continued elsewhere meanwhile: its transcript now ends on another model.
    setSelectedModel("default-model");
    attachConversation("chs_a", "model-a");
    attachConversation(null, null);
    expect(getSelectedModel()).toBe("default-model");

    attachConversation("chs_a", "model-b");
    expect(getSelectedModel()).toBe("model-b");
  });

  it("notifies on a change, and not on a re-attach that changes nothing", () => {
    let notifications = 0;
    const unsubscribe = subscribeModel(() => {
      notifications += 1;
    });
    try {
      attachConversation("chs_a", "model-a");
      expect(notifications).toBe(1);

      attachConversation("chs_a", "model-a");
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});

describe("seeding versus picking", () => {
  it("does not clobber a pick with a later seed for the same conversation", () => {
    // The history resolves (or refetches) after the user changed the model.
    // The pick is newer than the transcript and wins.
    attachConversation("chs_a", null);
    setSelectedModel("picked");
    attachConversation("chs_a", "from-history");

    expect(getSelectedModel()).toBe("picked");
  });

  it("makes a pick the open conversation's model AND the next new chat's default", () => {
    attachConversation("chs_a", null);
    setSelectedModel("picked");
    expect(getSelectedModel()).toBe("picked");

    attachConversation("chs_new", null);
    expect(getSelectedModel()).toBe("picked");
  });

  it("lets a pick override a model already seeded from history", () => {
    attachConversation("chs_a", "from-history");
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
    attachConversation("chs_a", "deleted-model");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("never pre-selects a listed model whose credential is dead", () => {
    setModelCatalog(catalog);
    attachConversation("chs_a", "dead-model");

    expect(getSelectedModel()).toBe("default-model");
  });

  it("drops a pre-selection the next catalog no longer serves live", () => {
    setModelCatalog([...catalog, { id: "model-a" }]);
    attachConversation("chs_a", "model-a");
    expect(getSelectedModel()).toBe("model-a");

    setModelCatalog(catalog);
    expect(getSelectedModel()).toBe("default-model");
  });

  it("keeps the user's own default when it drops a stale pre-selection", () => {
    // The user's default is live, only the conversation's model is not:
    // falling back must not overwrite it with the org default.
    setModelCatalog([...catalog, { id: "model-b" }]);
    setSelectedModel("model-b");
    attachConversation("chs_a", "deleted-model");

    expect(getSelectedModel()).toBe("model-b");
  });
});

describe("an own-credential model", () => {
  it("is a live custom model: never a built-in one, nor a custom one whose credential is dead", () => {
    // Disabled rows never reach the store: `fetchModels` drops them.
    const builtIn = { id: "platform", source: "built-in" as const };
    const deadCustom = { id: "byok-dead", source: "custom" as const, needs_reconnection: true };

    setModelCatalog([builtIn, deadCustom]);
    expect(hasOwnCredentialModel()).toBe(false);

    setModelCatalog([builtIn, deadCustom, { id: "byok", source: "custom" }]);
    expect(hasOwnCredentialModel()).toBe(true);
  });
});

describe("the stored preference follows the default model", () => {
  it("drops what a newly picked default does not accept", () => {
    setModelCatalog([
      { id: "model-a", generation: REASONING_HIGH },
      { id: "model-b", generation: NO_TEMPERATURE },
    ]);
    setSelectedModel("model-a");
    editGenerationSettings({ temperature: 0.7, reasoning_level: "high" });

    setSelectedModel("model-b");
    setSelectedModel("model-a");

    expect(getCompatibleGenerationSettings()).toEqual({ reasoning_level: "high" });
  });

  it("sends only what the selected model accepts", () => {
    setModelCatalog([{ id: "model", generation: NO_TEMPERATURE }]);
    setSelectedModel("model");
    editGenerationSettings({ temperature: 0.4 });

    expect(getCompatibleGenerationSettings()).toEqual({});
  });
});

describe("generation settings follow the model that is actually sent", () => {
  beforeEach(() => {
    setModelCatalog([
      { id: "default-model", is_default: true, generation: REASONING_HIGH },
      { id: "model-a", generation: NO_REASONING },
    ]);
    setSelectedModel("default-model");
    editGenerationSettings({ reasoning_level: "high" });
  });

  it("reconciles against a pre-selected model, not the stored default", () => {
    // Sending `high` with `X-Model-Id: model-a` is a 400.
    attachConversation("chs_a", "model-a");

    expect(getSelectedModel()).toBe("model-a");
    expect(getCompatibleGenerationSettings()).toEqual({});
  });

  it("does not erase the default's preference by opening an old conversation", () => {
    attachConversation("chs_a", "model-a");
    attachConversation("chs_new", null);

    expect(getCompatibleGenerationSettings()).toEqual({ reasoning_level: "high" });
  });

  it("keeps the default's reasoning when a setting is edited on a model without it", () => {
    // The picker shows `{}` on model-a; tuning the temperature there must not
    // write `{ temperature }` over the stored `{ reasoning_level: "high" }`.
    attachConversation("chs_a", "model-a");
    editGenerationSettings({ ...getCompatibleGenerationSettings(), temperature: 0.2 });
    expect(getCompatibleGenerationSettings()).toEqual({ temperature: 0.2 });

    attachConversation("chs_new", null);
    expect(getCompatibleGenerationSettings()).toEqual({
      reasoning_level: "high",
      temperature: 0.2,
    });
  });

  it("clears a shown setting the edit drops", () => {
    editGenerationSettings({ reasoning_level: "high", temperature: 0.2 });
    editGenerationSettings({ reasoning_level: "high" });

    expect(getCompatibleGenerationSettings()).toEqual({ reasoning_level: "high" });
  });

  it("returns a stable snapshot while nothing changed", () => {
    // A `useSyncExternalStore` snapshot: a fresh object per read loops.
    attachConversation("chs_a", "model-a");

    expect(getCompatibleGenerationSettings()).toBe(getCompatibleGenerationSettings());
  });
});
