// SPDX-License-Identifier: Apache-2.0

/**
 * What the composer offers is read from `GET /chat/commands`: the request it makes, what it
 * refuses to read, and when the read happens (where the conversation reaches, and only for a
 * caller who may write the chat).
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { fetchChatCommands, useChatCommands } from "../src/ui/use-chat-commands.ts";
import { requestAnswering, transportOf, transportOver } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";

const commands = {
  skills: [{ id: "@acme/tone", name: "tone", description: "Adjusts tone", version: "1.2.0" }],
  agents: [{ name: "run-report", title: "Report", description: "Weekly report" }],
};

describe("fetchChatCommands", () => {
  it("GETs the chat route without a space and parses what it serves", async () => {
    const request = requestAnswering(() => Response.json(commands));
    expect(await fetchChatCommands(transportOver(request), undefined)).toEqual(commands);
    expect(request.calls.map((c) => c.path)).toEqual(["/api/orgs/org_1/chat/commands"]);
  });

  it("names the origin space of a limited conversation", async () => {
    const request = requestAnswering(() => Response.json(commands));
    await fetchChatCommands(transportOver(request), "spc_a");
    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/orgs/org_1/chat/commands?spaceId=spc_a",
    ]);
  });

  it("keeps a draft skill's null version", async () => {
    const draft = { id: "@acme/wip", name: "wip", description: "", version: null };
    const request = requestAnswering(() => Response.json({ skills: [draft], agents: [] }));
    expect((await fetchChatCommands(transportOver(request), undefined)).skills).toEqual([draft]);
  });

  it("throws on a malformed answer and on a refusal", async () => {
    const malformed = requestAnswering(() => Response.json({ skills: [{ id: 1 }], agents: [] }));
    await expect(fetchChatCommands(transportOver(malformed), undefined)).rejects.toThrow();
    const refused = requestAnswering(() => new Response(null, { status: 403 }));
    await expect(fetchChatCommands(transportOver(refused), undefined)).rejects.toMatchObject({
      status: 403,
    });
  });
});

function Probe({ wanted }: { wanted: boolean }) {
  const read = useChatCommands(
    transportOf(() => ({})),
    wanted,
  );
  return <b data-fetch={read.fetchStatus} />;
}

/** Whether the read is requested, and under which key. */
function request(
  host: ChatHost,
  scope: { originSpaceId: string; restricted: boolean },
  wanted = true,
) {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider value={conversationScope(scope)}>
          <Probe wanted={wanted} />
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
  const [query] = qc.getQueryCache().findAll({ queryKey: ["packages", "chat-commands"] });
  return { fetches: html.match(/data-fetch="(\w+)"/)![1] === "fetching", key: query?.queryKey };
}

describe("useChatCommands", () => {
  const writer = testHost();

  it("reads for the acting set unless the conversation is limited to its origin space", () => {
    expect(request(writer, { originSpaceId: "spc_a", restricted: false })).toEqual({
      fetches: true,
      key: ["packages", "chat-commands", "org_1", null],
    });
    expect(request(writer, { originSpaceId: "spc_a", restricted: true })).toEqual({
      fetches: true,
      key: ["packages", "chat-commands", "org_1", "spc_a"],
    });
  });

  it("does not read when unwanted, nor for a caller who cannot write the chat", () => {
    expect(request(writer, { originSpaceId: "spc_a", restricted: false }, false).fetches).toBe(
      false,
    );
    const reader = testHost({ can: (permission) => permission !== "chat:write" });
    expect(request(reader, { originSpaceId: "spc_a", restricted: false }).fetches).toBe(false);
  });
});
