// SPDX-License-Identifier: Apache-2.0

/** When the skills catalogue is read: where the conversation reaches, not wherever the chat acts. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { useSkillCatalogue } from "../src/ui/use-skill-catalogue.ts";
import { transportOf } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";

// The chat acts in spc_a and spc_b; only spc_b grants `skills:read`.
const host = testHost({
  can: (permission) => permission === "skills:read",
  canIn: (spaceId, permission) => spaceId === "spc_b" && permission === "skills:read",
  actingSpaceIds: ["spc_a", "spc_b"],
});

function Catalogue() {
  const catalogue = useSkillCatalogue(
    transportOf(() => ({})),
    true,
  );
  return <b data-fetch={catalogue.fetchStatus} />;
}

/** Whether the catalogue is requested, and for which spaces. */
function request(originSpaceId: string, restricted: boolean) {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider value={conversationScope({ originSpaceId, restricted })}>
          <Catalogue />
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
  const [query] = qc.getQueryCache().findAll({ queryKey: ["packages", "skills"] });
  return {
    fetches: html.match(/data-fetch="(\w+)"/)![1] === "fetching",
    spaceIds: query?.queryKey[3],
  };
}

describe("the skills catalogue of a conversation", () => {
  it("is read, unlimited, across the acting set when some space where the chat acts grants it", () => {
    expect(request("spc_a", false)).toEqual({ fetches: true, spaceIds: ["spc_a", "spc_b"] });
  });

  it("is read, limited, in the origin space alone and only when that space grants it", () => {
    expect(request("spc_b", true)).toEqual({ fetches: true, spaceIds: ["spc_b"] });
    expect(request("spc_a", true)).toEqual({ fetches: false, spaceIds: ["spc_a"] });
  });
});
