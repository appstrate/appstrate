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
import {
  ChatHostProvider,
  ChatTransportProvider,
  type ChatHost,
} from "../src/ui/runtime-context.ts";
import {
  fetchChatCommands,
  useChatCommands,
  useKnownAgent,
  type AgentRef,
} from "../src/ui/use-chat-commands.ts";
import { requestAnswering, transportOf, transportOver } from "./fake-request.ts";
import { conversationScope, testHost } from "./test-host.ts";

const commands = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts tone", version: "1.2.0", bytes: 120 },
  ],
  agents: [
    {
      name: "run-report",
      title: "Report",
      description: "Weekly report",
      packageId: "@acme/report",
      spaceId: "spc_a",
      icon: null,
      color: null,
      integrations: [],
    },
  ],
};

describe("fetchChatCommands", () => {
  it("GETs the chat route without a space and parses what it serves", async () => {
    const request = requestAnswering(() => Response.json(commands));
    expect(await fetchChatCommands(transportOver(request), undefined, true)).toEqual(commands);
    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/orgs/org_1/chat/commands?package_authoring=true",
    ]);
  });

  it("passes the composer's authoring switch, so drafts are listed by the turn's rule", async () => {
    const request = requestAnswering(() => Response.json(commands));
    await fetchChatCommands(transportOver(request), undefined, false);
    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/orgs/org_1/chat/commands?package_authoring=false",
    ]);
  });

  it("names the origin space of a limited conversation", async () => {
    const request = requestAnswering(() => Response.json(commands));
    await fetchChatCommands(transportOver(request), "spc_a", true);
    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/orgs/org_1/chat/commands?spaceId=spc_a&package_authoring=true",
    ]);
  });

  it("keeps a draft skill's null version", async () => {
    const draft = { id: "@acme/wip", name: "wip", description: "", version: null, bytes: null };
    const request = requestAnswering(() => Response.json({ skills: [draft], agents: [] }));
    expect((await fetchChatCommands(transportOver(request), undefined, true)).skills).toEqual([
      draft,
    ]);
  });

  it("throws on a malformed answer and on a refusal", async () => {
    const malformed = requestAnswering(() => Response.json({ skills: [{ id: 1 }], agents: [] }));
    await expect(fetchChatCommands(transportOver(malformed), undefined, true)).rejects.toThrow();
    const refused = requestAnswering(() => new Response(null, { status: 403 }));
    await expect(fetchChatCommands(transportOver(refused), undefined, true)).rejects.toMatchObject({
      status: 403,
    });
  });
});

function Probe({ wanted }: { wanted: boolean }) {
  const read = useChatCommands(wanted);
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
        <ChatTransportProvider value={transportOf(() => ({}))}>
          <ConversationScopeProvider value={conversationScope(scope)}>
            <Probe wanted={wanted} />
          </ConversationScopeProvider>
        </ChatTransportProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
  const [query] = qc.getQueryCache().findAll({ queryKey: ["packages", "chat-commands"] });
  return { fetches: html.match(/data-fetch="(\w+)"/)![1] === "fetching", key: query?.queryKey };
}

describe("useChatCommands", () => {
  const writer = testHost({ actingSpaceIds: ["spc_a"] });

  it("reads for the acting set unless the conversation is limited to its origin space", () => {
    expect(request(writer, { originSpaceId: "spc_a", restricted: false })).toEqual({
      fetches: true,
      key: ["packages", "chat-commands", "org_1", null, true],
    });
    expect(request(writer, { originSpaceId: "spc_a", restricted: true })).toEqual({
      fetches: true,
      key: ["packages", "chat-commands", "org_1", "spc_a", true],
    });
  });

  it("does not read when unwanted, nor for a caller who cannot write the chat", () => {
    expect(request(writer, { originSpaceId: "spc_a", restricted: false }, false).fetches).toBe(
      false,
    );
    expect(request(writer, { originSpaceId: "spc_b", restricted: true }).fetches).toBe(false);
    const reader = testHost({ can: (permission) => permission !== "chat:write" });
    expect(request(reader, { originSpaceId: "spc_a", restricted: false }).fetches).toBe(false);
  });
});

describe("useKnownAgent", () => {
  // The same agent installed in two spaces, each install with its own integrations.
  const install = (spaceId: string, name: string, integration: string) => ({
    name,
    title: "Report",
    description: "",
    packageId: "@acme/report",
    spaceId,
    icon: null,
    color: null,
    integrations: [{ id: integration, name: integration, icon: null }],
  });
  const installs = {
    skills: [],
    agents: [
      install("spc_a", "run-report", "@acme/gmail"),
      install("spc_b", "run-b-report", "@acme/slack"),
    ],
  };

  function KnownProbe({ agentRef }: { agentRef: AgentRef }) {
    const agent = useKnownAgent(agentRef);
    return <b data-known={agent ? `${agent.spaceId}:${agent.integrations[0]!.id}` : "none"} />;
  }

  /** The entry `agentRef` reads, as `space:first integration`, or `none`. */
  function known(agentRef: AgentRef): string {
    const qc = new QueryClient();
    qc.setQueryData(["packages", "chat-commands", undefined, null, true], installs);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ChatHostProvider value={testHost()}>
          <KnownProbe agentRef={agentRef} />
        </ChatHostProvider>
      </QueryClientProvider>,
    );
    return html.match(/data-known="([^"]+)"/)![1]!;
  }

  it("reads the install of the space it is named with", () => {
    expect(known({ packageId: "@acme/report", spaceId: "spc_b" })).toBe("spc_b:@acme/slack");
    expect(known({ packageId: "@acme/report", spaceId: "spc_a" })).toBe("spc_a:@acme/gmail");
  });

  it("reads none for a space the agent is not offered in, never another space's install", () => {
    expect(known({ packageId: "@acme/report", spaceId: "spc_c" })).toBe("none");
  });

  it("reads the first install without a space, and one install by its prompt name", () => {
    expect(known({ packageId: "@acme/report" })).toBe("spc_a:@acme/gmail");
    expect(known({ promptName: "run-b-report" })).toBe("spc_b:@acme/slack");
  });
});
