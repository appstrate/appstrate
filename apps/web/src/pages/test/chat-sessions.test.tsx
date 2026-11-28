// SPDX-License-Identifier: Apache-2.0

import { linkedSpacePath } from "../../lib/across-spaces";
import { describe, expect, it } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { ChatConversationList, ChatTransportProvider } from "@appstrate/module-chat/ui";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import {
  sessionsQueryKey,
  type SessionsCache,
  type SessionSummary,
} from "../../../../../packages/module-chat/src/ui/sessions.ts";
import {
  ChatHostProvider,
  type ChatHost,
  type ChatTransport,
  type ThreadItem,
} from "../../../../../packages/module-chat/src/ui/runtime-context.ts";
import { FileAttachment } from "../../../../../packages/module-chat/src/ui/file-attachment.tsx";
import { ThreadRunLine } from "../../../../../packages/module-chat/src/ui/thread-run-line.tsx";
import { render } from "../../test/render.tsx";
import { ConversationUsage } from "../../modules/chat/conversation-info.tsx";
import { conversationStats } from "@appstrate/module-chat/conversation-stats";
import { mergeTurnMetadata } from "@appstrate/core/chat-turn-metadata";
import chatFr from "../../locales/fr/chat.json";
import i18n, { i18nReady } from "../../i18n.ts";

function conversation(id: string, title: string, unread: boolean): SessionSummary {
  return {
    id,
    title,
    unread,
    generating: false,
    updatedAt: "2026-09-05T10:00:00Z",
    spaceId: "spc_a",
    restricted: false,
    space_ids: ["spc_a"],
  };
}

/** One loaded page, as the session-list infinite query caches it. */
function cache(data: SessionSummary[]): SessionsCache {
  return { pages: [{ data, hasMore: false }], pageParams: [undefined] };
}

/** Filtered to one space; a static render reads the cache and never requests. */
const TRANSPORT: ChatTransport = {
  getHeaders: () => ({ "X-Space-Id": "spc_a" }),
  orgId: "org_1",
  spaceId: "spc_a",
  request: () => Promise.reject(new Error("no request in a static render")),
};

/**
 * Render the conversation list as the chat shell mounts it. The list is the
 * shell's navigation, not part of `ChatPage`; the transport provider is what
 * scopes the sessions query to one space. Its visibility read needs a document,
 * no DOM or effects.
 */
function renderConversationList(qc: QueryClient, can: (permission: string) => boolean): string {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible" },
  });
  try {
    return render(
      <SidebarProvider>
        <ChatTransportProvider value={TRANSPORT}>
          <ChatConversationList
            activeId="chat_active"
            t={(key) => key}
            can={can}
            renderSpaces={() => null}
          />
        </ChatTransportProvider>
      </SidebarProvider>,
      { queryClient: qc },
    );
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

function hostWith(granted: string[]): ChatHost {
  return {
    openFile: () => {},
    openThreadItem: () => {},
    useFileImageSrc: () => "blob:thumbnail",
    t: (key) => key,
    can: (permission) => granted.includes(permission),
    canIn: (_spaceId, permission) => granted.includes(permission),
    actingSpaceIds: ["spc_a"],
    attachTarget: { unavailable: "loading" },
    modelConfigs: [],
    modelCredentials: [],
    formatBytes: String,
    lang: "en",
    onPackagesChanged: () => {},
    renderSpaces: () => null,
    linkInSpace: (path, spaceId) => linkedSpacePath(path, spaceId, "spc_a"),
    useSpaceLabelOf: () => () => undefined,
  };
}

describe("chat page session scope", () => {
  it("derives unread markers from the same space cache as its conversation list", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      sessionsQueryKey("spc_a"),
      cache([
        conversation("chat_active", "Active conversation", true),
        conversation("chat_unread", "Unread in A", true),
        conversation("chat_read", "Read in A", false),
      ]),
    );
    qc.setQueryData(
      sessionsQueryKey("spc_b"),
      cache([conversation("chat_other", "Only in B", true)]),
    );

    const html = renderConversationList(qc, () => true);

    expect(html).toContain("Unread in A");
    expect(html).toContain("Read in A");
    expect(html).not.toContain("Only in B");
    // The unread dot lives in the list itself, and the test injects an identity
    // `t`, so the rendered label is the KEY. Counting it is what proves the
    // marker is derived from the same scoped query as the rows beside it —
    // `chat_active` is excluded because looking at a thread reads it.
    expect(html.match(/aria-label="threads\.unread"/g)).toHaveLength(1);
  });
});

describe("chat surfaces held to the caller's grants", () => {
  it("tells a read-only caller with no conversations nothing about sending one", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionsQueryKey("spc_a"), cache([]));

    const readOnly = renderConversationList(qc, (p) => p === "chat:read");
    expect(readOnly).toContain("threads.emptyReadOnly");
    expect(readOnly).not.toContain("threads.empty<");

    const writer = renderConversationList(qc, (p) => p === "chat:read" || p === "chat:write");
    expect(writer).toContain("threads.empty<");
  });

  it("offers no preview, download or thumbnail of a file without files:read", () => {
    const file = { id: "file_1", name: "report.png", mime: "image/png" };
    const denied = render(
      <ChatHostProvider value={hostWith([])}>
        <FileAttachment file={file} />
      </ChatHostProvider>,
    );
    expect(denied).toContain("report.png");
    expect(denied).toContain('title="file.noAccess"');
    expect(denied).not.toContain("<button");
    expect(denied).not.toContain("blob:thumbnail");

    const granted = render(
      <ChatHostProvider value={hostWith(["files:read"])}>
        <FileAttachment file={file} />
      </ChatHostProvider>,
    );
    expect(granted).toContain("<button");
    expect(granted).toContain("blob:thumbnail");
  });

  it("says a live run is out of reach instead of starting forever", () => {
    const card = (granted: string[]) =>
      render(
        <ChatHostProvider value={hostWith(granted)}>
          <ThreadRunLine
            toolCallId="call_1"
            runId="run_1"
            initialStatus="running"
            initialPackageId="@acme/bot"
            spaceId="spc_b"
            phase="success"
          />
        </ChatHostProvider>,
      );

    const denied = card([]);
    expect(denied).toContain("run.noAccess");
    expect(denied).not.toContain("run.starting");
    expect(denied).not.toContain('title="run.openPage"');
    // A run out of reach has nothing to show in the panel either: its name is no button.
    expect(denied).not.toContain("<button");

    const granted = card(["runs:read"]);
    expect(granted).toContain("run.starting");
    expect(granted).toContain('title="run.openPage"');
    expect(granted).toContain("?enterSpace=spc_b");
    expect(granted).toContain("<button");
  });
});

describe("chat run line", () => {
  const agent = {
    name: "run-bot",
    title: "Bot",
    description: "",
    packageId: "@acme/bot",
    spaceId: "spc_a",
    icon: "lucide:mail",
    color: "teal",
    integrations: [
      { id: "@acme/gmail", name: "Gmail", icon: null },
      { id: "@acme/slack", name: "Slack", icon: null },
    ],
  };
  /** The line under a commands cache holding `agents`, keyed as `useChatCommands` reads it outside a transport. */
  const card = (packageId: string | undefined, phase: "running" | "error" = "running") => {
    const qc = new QueryClient();
    qc.setQueryData(["packages", "chat-commands", undefined, null, true], {
      skills: [],
      agents: [agent],
    });
    return render(
      <ChatHostProvider value={hostWith(["runs:read"])}>
        <ThreadRunLine
          runId={undefined}
          agentLabel="@acme/bot"
          initialPackageId={packageId}
          spaceId={agent.spaceId}
          phase={phase}
        />
      </ChatHostProvider>,
      { queryClient: qc },
    );
  };

  it("leads with the agent's tile and follows its name with its integrations, named", () => {
    const html = card("@acme/bot");
    expect(html).toContain("size-4 shrink-0 rounded-sm");
    expect(html).not.toContain("bg-muted text-muted-foreground flex size-4");
    const label = i18n.t("common:integrationStack.label", { names: "Gmail, Slack" });
    expect(html).toContain(`role="img" aria-label="${label}"`);
    expect(html.indexOf(label)).toBeGreaterThan(html.indexOf("@acme/bot<"));
  });

  it("draws the neutral bot tile, and no logos, for an agent the commands do not hold", () => {
    const html = card("@inline/shadow");
    expect(html).toContain("bg-muted text-muted-foreground flex size-4");
    expect(html).not.toContain('data-testid="integration-logo-stack"');
  });

  /** The first element under `node`, through every prop, whose props satisfy `match`. */
  function findElement(
    node: ReactNode,
    match: (props: Record<string, unknown>) => boolean,
  ): ReactElement<Record<string, unknown>> | undefined {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findElement(child, match);
        if (hit) return hit;
      }
      return undefined;
    }
    const el = node as ReactElement<Record<string, unknown>>;
    if (!el.props) return undefined;
    if (match(el.props)) return el;
    // Through every prop, not only `children`: a line's control is one of its props.
    for (const value of Object.values(el.props)) {
      const hit = findElement(value as ReactNode, match);
      if (hit) return hit;
    }
    return undefined;
  }

  it("opens its run in the host's panel on a click", () => {
    const opened: ThreadItem[] = [];
    function Probe() {
      const tree = ThreadRunLine({
        runId: "run_1",
        initialStatus: "success",
        agentLabel: "@acme/bot",
        initialPackageId: "@acme/bot",
        phase: "success",
      });
      const button = findElement(tree, (props) => typeof props.onClick === "function");
      (button!.props.onClick as () => void)();
      return null;
    }
    render(
      <ChatHostProvider
        value={{ ...hostWith(["runs:read"]), openThreadItem: (item) => opened.push(item) }}
      >
        <Probe />
      </ChatHostProvider>,
    );
    expect(opened).toEqual([{ kind: "run", id: "run_1" }]);
  });

  it("is no button on a launch failure: no run to open, its state on the line", () => {
    const failed = card("@acme/bot", "error");
    expect(failed).not.toContain("<button");
    expect(failed).toContain("run.launchFailed");
  });

  it("follows the name with its state: a spinner until it is known, an alert on a launch failure", () => {
    const starting = card("@acme/bot");
    expect(starting).not.toContain("absolute -right-1 -bottom-1");
    expect(starting).toContain("animate-spin");
    const failed = card("@acme/bot", "error");
    expect(failed).not.toContain("animate-spin");
    expect(failed).toContain("text-destructive");
    expect(failed).toContain("run.launchFailed");
  });
});

describe("conversation sidebar usage", () => {
  const session = (windowAssumed: boolean) =>
    ({
      messages: [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
          metadata: mergeTurnMetadata(undefined, {
            finishReason: "stop",
            stepCount: 1,
            maxSteps: 16,
            maxStepsReached: false,
            modelId: "mdl_a",
            modelLabel: "Model A",
            context: {
              tokens: 64_000,
              window: 128_000,
              compactAt: 100_000,
              ...(windowAssumed ? { windowAssumed: true as const } : {}),
            },
          }),
        },
      ],
      usage: {},
    }) as unknown as Parameters<typeof ConversationUsage>[0]["session"];
  const usage = (assumed: boolean) => {
    const conversation = session(assumed);
    return (
      <ConversationUsage session={conversation} stats={conversationStats(conversation.messages)} />
    );
  };

  it("marks an assumed window with ≈ and says why", async () => {
    await i18nReady;
    await i18n.changeLanguage("fr");
    await i18n.loadNamespaces("chat");
    const html = render(usage(true));
    expect(html).toContain("≈");
    expect(html).toContain(chatFr["contextUsage.windowAssumed"].split("{{window}}")[0]!.trim());
  });

  it("states nothing about the window when the model declared it", async () => {
    await i18nReady;
    await i18n.changeLanguage("fr");
    await i18n.loadNamespaces("chat");
    const html = render(usage(false));
    expect(html).not.toContain("≈");
    expect(html).not.toContain(chatFr["contextUsage.windowAssumed"].split("{{window}}")[0]!.trim());
  });
});
