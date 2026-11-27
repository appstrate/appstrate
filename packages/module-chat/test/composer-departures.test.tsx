// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's settings off their default, mounted for real: a static render reads every
 * per-user flag at its default (`useSyncExternalStore`'s server snapshot), so a turned switch
 * shows only in a client render. The DOM globals come from `dom-shim.ts`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useComposerDepartures, type ComposerDeparture } from "../src/ui/composer-panel.ts";
import { setContextAllSpacesEnabled } from "../src/ui/context-all-spaces-store.ts";
import { ConversationScopeProvider, type ConversationScope } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { container, installDomShim } from "./dom-shim.ts";
import { conversationScope, testHost } from "./test-host.ts";

installDomShim();
afterEach(() => setContextAllSpacesEnabled(true));

/** The departures a composer shows, for a conversation that can act in `acting`. */
function departures(scope: ConversationScope, acting: string[]): readonly ComposerDeparture[] {
  let seen: readonly ComposerDeparture[] = [];
  function Probe() {
    seen = useComposerDepartures(false);
    return null;
  }
  const root = createRoot(container());
  act(() =>
    root.render(
      <ChatHostProvider value={testHost({ actingSpaceIds: acting })}>
        <ConversationScopeProvider value={scope}>
          <Probe />
        </ConversationScopeProvider>
      </ChatHostProvider>,
    ),
  );
  act(() => root.unmount());
  return seen;
}

describe("the every-space context among the composer's departures", () => {
  it("is none at the default: every space is detailed", () => {
    expect(departures(conversationScope(), ["spc_a", "spc_b"])).toEqual([]);
  });

  it("is one once the switch is off, where the switch is offered", () => {
    setContextAllSpacesEnabled(false);
    expect(departures(conversationScope(), ["spc_a", "spc_b"])).toEqual(["contextAllSpacesOff"]);
    // Neither one space to act in nor a limited conversation offers the switch: nothing to say.
    expect(departures(conversationScope(), ["spc_a"])).toEqual([]);
    expect(
      departures(conversationScope({ originSpaceId: "spc_a", restricted: true }), [
        "spc_a",
        "spc_b",
      ]),
    ).toEqual(["limit"]);
  });
});
