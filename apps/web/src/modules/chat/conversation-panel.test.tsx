// SPDX-License-Identifier: Apache-2.0

/**
 * The context panel. Closed, its reads wait (`active` false), and nothing it draws in the meantime
 * is an error or an empty list made up from a read that never ran. Open, each group of the summary
 * stands on its own read. The Tools tab lists the calls by turn as step lines, lookups behind a
 * switch, a call's detail open on its line. The Info tab shows its sections open.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { renderInSpace, memberSpaceClient, testSpace } = await import("../../test/space-context.ts");
const { makeRun } = await import("../../test/run-fixture.ts");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { formatDuration } = await import("../../lib/format-duration.ts");
const { ConversationSummary } = await import("./conversation-summary.tsx");
const { ConversationInfo } = await import("./conversation-info.tsx");
const { ConversationFiles } = await import("./conversation-sidebar.tsx");
const { ConversationRuns } = await import("./conversation-runs-tab.tsx");
const { ConversationToolsList } = await import("./conversation-tools-tab.tsx");
const { INITIAL_CONVERSATION_SIDEBAR_STATE, conversationSidebarReducer, openToolCallId } =
  await import("./conversation-sidebar-state.ts");
const { publishLiveConversation, withdrawLiveConversation } =
  await import("@appstrate/module-chat/live-conversation");
const { ChatTransportProvider } = await import("@appstrate/module-chat/ui");

/** The chat's transport, so the conversation's own read is built as the page builds it. */
const TRANSPORT = {
  getHeaders: () => ({ "X-Space-Id": "spc_a" }),
  orgId: "org_1",
  spaceId: "spc_a",
  request: () => Promise.reject(new Error("no request in a static render")),
};

await i18nReady;
await i18n.changeLanguage("fr");
await i18n.loadNamespaces(["chat", "common"]);

const spaces = [testSpace("spc_a", ["chat:read", "runs:read", "files:read"])];
const noop = () => {};

/** The Tools list's props past its conversation: switch off, every line folded. */
const TOOLS_PROPS = {
  showLookups: false,
  onShowLookupsChange: noop,
  openToolCallId: null,
  missing: false,
  onOpenChange: noop,
  onShowInThread: noop,
};

/** The Runs list's props past its conversation: every line folded. */
const RUNS_PROPS = {
  openRunId: null,
  missing: false,
  onOpenChange: noop,
  onShowInThread: noop,
  onSelectFile: noop,
};

/** The conversation as the server stores it, its assistant turns holding `turns`' parts. */
function seedConversation(queryClient: QueryClient, turns: unknown[][]) {
  queryClient.setQueryData(
    ["get", "/api/orgs/{orgId}/chat/sessions/{id}", { params: { path: { id: "chs_1" } } }],
    {
      id: "chs_1",
      title: "Rapport",
      generating: false,
      unread: false,
      updatedAt: "2026-11-26T10:00:00.000Z",
      createdAt: "2026-11-26T09:00:00.000Z",
      spaceId: "spc_a",
      restricted: false,
      space_ids: ["spc_a"],
      usage: {},
      skills: { discovery: true, pins: [] },
      messages: turns.map((parts, i) => ({ id: `msg_${i + 1}`, role: "assistant", parts })),
    },
  );
}

const runsKey: QueryKey = [
  "get",
  "/api/orgs/{orgId}/runs",
  { params: { path: { orgId: "org_1" }, query: { chat_session_id: "chs_1", limit: 100 } } },
];
const filesKey: QueryKey = [
  "get",
  "/api/orgs/{orgId}/files",
  {
    params: { path: { orgId: "org_1" }, query: { context_chat_session_id: "chs_1", limit: 100 } },
  },
];
const integrationsKey: QueryKey = [
  "get",
  "/api/orgs/{orgId}/chat/sessions/{id}/integrations",
  { params: { path: { orgId: "org_1", id: "chs_1" } } },
];

const list = (data: unknown[], total = data.length) => ({
  object: "list",
  data,
  total,
  hasMore: false,
});

/** A read that failed: `data` kept when the cache held some (a refetch that failed). */
function failRead(queryClient: QueryClient, key: QueryKey, data?: unknown) {
  if (data !== undefined) queryClient.setQueryData(key, data);
  const query = queryClient.getQueryCache().build(queryClient, { queryKey: key });
  query.setState({
    ...query.state,
    status: "error",
    error: new Error("boom"),
    fetchStatus: "idle",
  });
}

/** The member's query client, recording the options every read of the tree is built with. */
function recordingClient() {
  const client = memberSpaceClient(spaces);
  const built: { key: string; enabled: unknown }[] = [];
  const defaults = client.defaultQueryOptions.bind(client);
  client.defaultQueryOptions = ((options: Parameters<typeof defaults>[0]) => {
    const defaulted = defaults(options);
    built.push({ key: JSON.stringify(defaulted.queryKey), enabled: defaulted.enabled });
    return defaulted;
  }) as typeof client.defaultQueryOptions;
  // The conversation's reads: their keys carry its id.
  const conversationReads = () => built.filter(({ key }) => key.includes("chs_1"));
  return { client, conversationReads };
}

function render(node: React.ReactElement, queryClient: QueryClient = memberSpaceClient(spaces)) {
  return renderInSpace(node, { queryClient, overview: false });
}

/** The Tools tab's step lines: one disclosure trigger each. */
const rowsOf = (html: string) => html.split("aria-expanded=").length - 1;

const GMAIL = { kind: "integration", id: "@acme/gmail", display_name: "Gmail" };

/**
 * A stored tool part: an action unless `lookup`, ran for `durationMs` when given, presented as the
 * platform stamps it (`integration`: a call that reached Gmail).
 */
function toolPart(
  toolCallId: string,
  {
    lookup = false,
    state = "output-available",
    durationMs,
    integration = false,
    presentation = integration ? { call: "proxied_request", subject: GMAIL } : undefined,
  }: {
    lookup?: boolean;
    state?: string;
    durationMs?: number;
    integration?: boolean;
    presentation?: Record<string, unknown>;
  } = {},
) {
  const outcome = {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(presentation ? { presentation } : {}),
  };
  return {
    type: integration ? "tool-call_integration_tool" : "tool-invoke_operation",
    toolCallId,
    state,
    input: { operation_id: toolCallId },
    ...(state === "output-available" ? { output: { ok: true } } : {}),
    ...(state === "output-error" ? { errorText: "boom" } : {}),
    ...(lookup ? { callProviderMetadata: { appstrate: { lookup: true } } } : {}),
    ...(Object.keys(outcome).length > 0 ? { resultProviderMetadata: { appstrate: outcome } } : {}),
  };
}

/** A stored part as a call without outcome stamp: still running, or cut before it resolved. */
function unstamped(part: ReturnType<typeof toolPart>) {
  const { resultProviderMetadata: _stamp, ...rest } = part;
  return rest;
}

describe("the context panel, closed", () => {
  const panes: [string, React.ReactElement<{ active: boolean }>][] = [
    ["Résumé", <ConversationSummary conversationId="chs_1" active={false} dispatch={noop} />],
    ["Infos", <ConversationInfo conversationId="chs_1" active={false} />],
    ["Runs", <ConversationRuns conversationId="chs_1" active={false} {...RUNS_PROPS} />],
    [
      "Runs, un run ouvert",
      <ConversationRuns conversationId="chs_1" active={false} {...RUNS_PROPS} openRunId="run_1" />,
    ],
    ["Fichiers", <ConversationFiles conversationId="chs_1" active={false} onSelect={noop} />],
    ["Outils", <ConversationToolsList conversationId="chs_1" active={false} {...TOOLS_PROPS} />],
    [
      "Outils, un appel ouvert",
      <ConversationToolsList
        conversationId="chs_1"
        active={false}
        {...TOOLS_PROPS}
        openToolCallId="call_1"
      />,
    ],
  ];

  for (const [name, pane] of panes) {
    it(`holds ${name} in its loading shape, never an error or an empty list`, () => {
      const html = render(pane);
      expect(html).not.toContain(i18n.t("common:error.generic"));
      expect(html).not.toContain(i18n.t("chat:context.runs.empty"));
      expect(html).not.toContain(i18n.t("chat:context.files.empty"));
      expect(html).not.toContain(i18n.t("chat:context.tools.empty"));
      // One `status` for the pane that waits.
      expect(html.split('role="status"').length - 1).toBe(1);
    });
  }

  it("builds every read of its views disabled while closed, and enables them once open", () => {
    const views = (active: boolean) => (
      <ChatTransportProvider value={TRANSPORT}>
        <ConversationSummary conversationId="chs_1" active={active} dispatch={noop} />
        <ConversationInfo conversationId="chs_1" active={active} />
        <ConversationRuns
          conversationId="chs_1"
          active={active}
          {...RUNS_PROPS}
          openRunId="run_1"
        />
        <ConversationFiles conversationId="chs_1" active={active} onSelect={noop} />
        <ConversationToolsList
          conversationId="chs_1"
          active={active}
          {...TOOLS_PROPS}
          openToolCallId="call_1"
        />
      </ChatTransportProvider>
    );
    const closed = recordingClient();
    render(views(false), closed.client);
    expect(closed.conversationReads().length).toBeGreaterThan(0);
    expect(closed.conversationReads().filter(({ enabled }) => enabled !== false)).toEqual([]);

    const open = recordingClient();
    render(views(true), open.client);
    expect(open.conversationReads().some(({ enabled }) => enabled === true)).toBe(true);
  });
});

describe("the summary, open", () => {
  /** The summary once its conversation holds `parts` and its runs reads answered. */
  function summary(
    parts: unknown[],
    runs: unknown[] | ReturnType<typeof list>,
    { active = true, prepare }: { active?: boolean; prepare?: (qc: QueryClient) => void } = {},
  ): string {
    const queryClient = memberSpaceClient(spaces);
    seedConversation(queryClient, [parts]);
    queryClient.setQueryData(runsKey, Array.isArray(runs) ? list(runs) : runs);
    queryClient.setQueryData(filesKey, { object: "list", data: [], hasMore: false });
    queryClient.setQueryData(integrationsKey, { object: "list", data: [], hasMore: false });
    prepare?.(queryClient);
    return render(
      <ConversationSummary conversationId="chs_1" active={active} dispatch={noop} />,
      queryClient,
    );
  }

  it("draws « Intégrations » with the integration calls, lookups included, and never a platform call", () => {
    const html = summary(
      [
        toolPart("call_i", { integration: true }),
        toolPart("call_l", { integration: true, lookup: true }),
        toolPart("call_p"),
        toolPart("call_s", { lookup: true }),
        // An operation on an integration package is the platform's, its subject notwithstanding.
        toolPart("call_o", {
          presentation: { call: "operation", tag: "Integrations", method: "GET", subject: GMAIL },
        }),
      ],
      [],
    );
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    // One line per integration call (Gmail's glyph, no icon: the puzzle), none for the platform's own.
    expect(html.split("lucide-puzzle").length - 1).toBe(2);
  });

  it("draws an integration call with no stamp yet: in flight, or cut before it resolved", () => {
    const html = summary(
      [
        unstamped(toolPart("call_r", { integration: true, state: "input-available" })),
        unstamped(toolPart("call_x", { integration: true, state: "output-error" })),
      ],
      [],
    );
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    // Its own icon, the plug, with no subject to draw.
    expect(html.split("lucide-plug").length - 1).toBe(2);
  });

  it("leads each group holding more to its tab, counted where the server counts", () => {
    const runs = [1, 2, 3].map((n) => makeRun({ id: `run_${n}`, runNumber: n }));
    const counted = summary([], list(runs, 240));
    expect(counted).toContain(i18n.t("chat:context.summary.seeAllCount", { count: 240 }));

    const calls = [1, 2, 3, 4].map((n) => toolPart(`call_${n}`, { integration: true }));
    const uncounted = summary(calls, []);
    expect(uncounted).toContain(i18n.t("chat:context.summary.seeAll"));
    expect(uncounted).not.toContain(`${i18n.t("chat:context.summary.seeAll")} (`);
  });

  it("leaves « Intégrations » out when only platform tools were called", () => {
    const html = summary([toolPart("call_p")], []);
    expect(html).not.toContain(i18n.t("chat:context.summary.integrations"));
    expect(html).toContain(i18n.t("chat:context.summary.noActivity"));
    expect(html).toContain(i18n.t("chat:context.summary.noActivityHint"));
  });

  it("says an unsaved conversation has no summary yet, as the other tabs do", () => {
    const html = render(<ConversationSummary conversationId={null} active dispatch={noop} />);
    expect(html).toContain(i18n.t("chat:context.unsaved"));
  });

  it("shows a failure on its own run and call line", () => {
    const failed = makeRun({ id: "run_7", runNumber: 7, status: "failed" });
    const failedCall = toolPart("call_f", { integration: true, state: "output-error" });
    const html = summary([failedCall], [failed]);
    expect(html).toContain("#7");
    expect(html).toContain(i18n.t("chat:context.tools.status.error"));
  });

  it("draws a run as a button opening it in the panel, led by its agent's tile", () => {
    const html = summary([], [makeRun({ id: "run_4", runNumber: 4, package_ephemeral: false })]);
    const line = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    expect(line).toContain("#4");
    expect(line).toContain('type="button"');
    expect(line).not.toContain("lucide-activity");
    // The run's page is one click away in the open run, not from the line.
    expect(html).not.toContain("<a ");
  });

  it("keeps what the cache holds while the panel closes: no skeleton, no read lost", () => {
    const html = summary([], [makeRun({ id: "run_9", runNumber: 9 })], { active: false });
    expect(html).toContain("Rapport");
    expect(html).toContain("#9");
    expect(html).not.toContain('role="status"');
  });

  it("shows its calls at once while the runs are read, the runs waiting in their place", () => {
    const html = summary([toolPart("call_a", { integration: true })], [], {
      prepare: (qc) => qc.removeQueries({ queryKey: runsKey, exact: true }),
    });
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    expect(html.split('role="status"').length - 1).toBe(1);
  });

  it("says a failed read in its group alone, the other groups shown", () => {
    // Held closed: open, the read would be tried again on mount.
    const html = summary([toolPart("call_a", { integration: true })], [], {
      active: false,
      prepare: (qc) => {
        qc.removeQueries({ queryKey: runsKey, exact: true });
        failRead(qc, runsKey);
      },
    });
    expect(html).toContain(i18n.t("common:error.generic"));
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    expect(html).toContain("Rapport");
  });

  it("stacks the integrations it reached beside « Intégrations », named for assistive tech", () => {
    const html = summary([], [], {
      prepare: (qc) =>
        qc.setQueryData(integrationsKey, {
          object: "list",
          data: [
            { id: "@acme/gmail", display_name: "Gmail", icon: null },
            { id: "@acme/clickup", display_name: "ClickUp", icon: null },
          ],
          hasMore: false,
        }),
    });
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    expect(html).toContain('data-testid="integration-logo-stack"');
    expect(html).toContain(
      `aria-label="${i18n.t("common:integrationStack.label", { names: "Gmail, ClickUp" })}"`,
    );
    // Reached by its runs alone, an integration is still activity.
    expect(html).not.toContain(i18n.t("chat:context.summary.noActivity"));
  });

  it("waits for the integrations reached in their place, the calls shown meanwhile", () => {
    const pending = (parts: unknown[]) =>
      summary(parts, [], {
        prepare: (qc) => qc.removeQueries({ queryKey: integrationsKey, exact: true }),
      });

    const alone = pending([]);
    expect(alone).not.toContain(i18n.t("chat:context.summary.integrations"));
    expect(alone).not.toContain(i18n.t("chat:context.summary.noActivity"));
    expect(alone.split('role="status"').length - 1).toBe(1);

    const withCalls = pending([toolPart("call_a", { integration: true })]);
    expect(withCalls).toContain(i18n.t("chat:context.summary.integrations"));
    expect(withCalls.split("lucide-puzzle").length - 1).toBe(1);
    expect(withCalls).not.toContain('data-testid="integration-logo-stack"');
    expect(withCalls.split('role="status"').length - 1).toBe(1);
  });

  it("says a failed read of the integrations reached in « Intégrations »", () => {
    // Held closed: open, the read would be tried again on mount.
    const html = summary([], [], {
      active: false,
      prepare: (qc) => {
        qc.removeQueries({ queryKey: integrationsKey, exact: true });
        failRead(qc, integrationsKey);
      },
    });
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    expect(html).toContain(i18n.t("common:error.generic"));
    expect(html).not.toContain(i18n.t("chat:context.summary.noActivity"));
  });

  it("keeps the runs it holds when their refetch fails", () => {
    const html = summary([], [], {
      prepare: (qc) => failRead(qc, runsKey, list([makeRun({ runNumber: 11 })])),
    });
    expect(html).toContain("#11");
    expect(html).not.toContain(i18n.t("common:error.generic"));
  });
});

describe("the Info tab, open", () => {
  const usage = i18n.t("chat:context.summary.usageTitle");
  const access = i18n.t("chat:context.summary.access");
  const details = i18n.t("chat:context.summary.details");

  it("shows models and tokens, access and details as open sections", () => {
    const queryClient = memberSpaceClient(spaces);
    seedConversation(queryClient, [[]]);
    const html = render(<ConversationInfo conversationId="chs_1" active />, queryClient);
    for (const title of [usage, access, details]) expect(html).toContain(title);
    expect(html).toContain("chs_1");
    expect(html).not.toContain("aria-expanded");
  });

  it("shows the access alone for a conversation not stored yet", () => {
    const html = render(<ConversationInfo conversationId={null} active />);
    expect(html).toContain(access);
    expect(html).not.toContain(usage);
    expect(html).not.toContain(details);
  });
});

describe("the Tools tab, open", () => {
  function tools(
    turns: unknown[][],
    {
      showLookups = false,
      openToolCallId = null,
      missing = false,
    }: { showLookups?: boolean; openToolCallId?: string | null; missing?: boolean } = {},
  ): string {
    const queryClient = memberSpaceClient(spaces);
    seedConversation(queryClient, turns);
    return render(
      <ConversationToolsList
        conversationId="chs_1"
        active
        {...TOOLS_PROPS}
        showLookups={showLookups}
        openToolCallId={openToolCallId}
        missing={missing}
      />,
      queryClient,
    );
  }

  it("keeps the lookups behind its switch, which counts them", () => {
    const turns = [[toolPart("call_a"), toolPart("call_l1", { lookup: true })]];
    const hidden = tools([[...turns[0]!, toolPart("call_l2", { lookup: true })]]);
    expect(hidden).toContain(i18n.t("chat:context.tools.showLookups", { count: 2 }));
    expect(rowsOf(hidden)).toBe(1);
    const shown = tools([[...turns[0]!, toolPart("call_l2", { lookup: true })]], {
      showLookups: true,
    });
    expect(rowsOf(shown)).toBe(3);
  });

  it("lists the lookup it holds open with the switch off", () => {
    const html = tools([[toolPart("call_a"), toolPart("call_l1", { lookup: true })]], {
      openToolCallId: "call_l1",
    });
    expect(rowsOf(html)).toBe(2);
    expect(html).toContain('aria-expanded="true"');
  });

  it("lists and opens a hidden lookup the thread opened, as one opened from the summary", () => {
    // The thread's line opens its call through the host, mapped to the reducer's one action.
    const state = conversationSidebarReducer(INITIAL_CONVERSATION_SIDEBAR_STATE, {
      type: "show-item",
      item: { kind: "call", id: "call_l1" },
    });
    expect(state).toMatchObject({ expanded: true, activeTab: "tools", showLookups: false });
    const html = tools([[toolPart("call_a"), toolPart("call_l1", { lookup: true })]], {
      openToolCallId: openToolCallId(state),
    });
    expect(rowsOf(html)).toBe(2);
    expect(html.split('aria-expanded="true"').length - 1).toBe(1);
  });

  it("lists the calls under their turn", () => {
    const html = tools([[toolPart("call_a")], [toolPart("call_b"), toolPart("call_c")]]);
    const first = html.indexOf(i18n.t("chat:context.tools.turn", { turn: 1 }));
    const second = html.indexOf(i18n.t("chat:context.tools.turn", { turn: 2 }));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(rowsOf(html.slice(first, second))).toBe(1);
    expect(rowsOf(html.slice(second))).toBe(2);
  });

  it("counts each turn's calls beside its heading as the thread's group does", () => {
    const html = tools([
      [
        toolPart("call_a"),
        toolPart("call_l1", { lookup: true }),
        toolPart("call_l2", { lookup: true }),
      ],
      [toolPart("call_b")],
    ]);
    const second = html.indexOf(i18n.t("chat:context.tools.turn", { turn: 2 }));
    const reads = i18n.t("chat:tool.reads.done", { count: 2 });
    const actions = i18n.t("chat:tool.actions.done", { count: 1 });
    // The hidden lookups count all the same: the heading says the whole turn.
    expect(html.slice(0, second)).toContain(`${reads} · ${actions}`);
    expect(html.slice(second)).toContain(actions);
    expect(html.slice(second)).not.toContain(i18n.t("chat:tool.reads.done", { count: 1 }));
  });

  it("draws a call on an agent outside the chat host", () => {
    const agent = { kind: "agent", id: "@acme/bot", display_name: "Bot" };
    const html = tools([
      [
        toolPart("call_a", {
          presentation: { call: "operation", tag: "Agents", method: "POST", subject: agent },
        }),
      ],
    ]);
    expect(rowsOf(html)).toBe(1);
    expect(html).toContain("Bot");
  });

  it("says how long a call ran on its line", () => {
    const html = tools([[toolPart("call_a", { durationMs: 1200 })]]);
    expect(html).toContain(formatDuration(1200));
  });

  it("folds every call's detail until one is open", () => {
    const html = tools([[toolPart("call_a")]]);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain(i18n.t("chat:tool.detail.input"));
  });

  it("holds a call opened from the summary open on its line: its detail, its way to the thread", () => {
    const html = tools([[toolPart("call_a", { durationMs: 2500 }), toolPart("call_b")]], {
      openToolCallId: "call_a",
    });
    expect(html.split('aria-expanded="true"').length - 1).toBe(1);
    expect(html.split('aria-expanded="false"').length - 1).toBe(1);
    expect(html).toContain(formatDuration(2500));
    expect(html).toContain(i18n.t("chat:tool.detail.input"));
    expect(html).toContain(i18n.t("chat:context.showInThread"));
    expect(html).not.toContain(i18n.t("chat:context.tools.notInThread"));
  });

  it("says under the open call that the last reveal found no card", () => {
    const html = tools([[toolPart("call_a"), toolPart("call_b")]], {
      openToolCallId: "call_a",
      missing: true,
    });
    expect(html.split(i18n.t("chat:context.tools.notInThread")).length - 1).toBe(1);
  });

  it("says a failed call the thread's way: a cross named by its outcome, its message under the line", () => {
    const turns = [[toolPart("call_x", { state: "output-error" })]];
    const folded = tools(turns);
    expect(folded).toContain("lucide-x");
    // No word beside the cross: it is named for assistive tech, the message says the rest.
    expect(folded).toContain(
      `role="img" aria-label="${i18n.t("chat:context.tools.status.error")}"`,
    );
    expect(folded).not.toContain(`>${i18n.t("chat:context.tools.status.error")}<`);
    expect(folded).toMatch(/<p class="text-muted-foreground[^"]*"[^>]*>boom</);
    // The cross alone is red: the call's own icon keeps the line's muted tone.
    expect(folded.split("text-destructive").length - 1).toBe(1);
    const open = tools(turns, { openToolCallId: "call_x" });
    expect(open).toContain(i18n.t("chat:tool.detail.error"));
  });

  it("reads the open chat's turn in flight: its call without outcome is running", () => {
    publishLiveConversation("chs_1", {
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          parts: [toolPart("call_live", { state: "input-available" })],
        },
      ] as never,
      running: true,
    });
    try {
      // Nothing stored: the live conversation alone answers.
      const html = render(<ConversationToolsList conversationId="chs_1" active {...TOOLS_PROPS} />);
      // Its label shimmers, as the thread's running step does.
      expect(html).toContain("shimmer-text");
      expect(html).not.toContain('role="status"');
    } finally {
      withdrawLiveConversation("chs_1");
    }
  });
});

describe("the Runs and Files tabs, open", () => {
  it("keep the rows they hold when a refetch fails", () => {
    const queryClient = memberSpaceClient(spaces);
    failRead(queryClient, runsKey, list([makeRun({ runNumber: 12 })]));
    failRead(
      queryClient,
      filesKey,
      list([
        {
          id: "fil_1",
          name: "rapport.pdf",
          mime: "application/pdf",
          size: 10,
          purpose: "user_upload",
          createdAt: "2026-11-26T10:00:00.000Z",
          spaceId: "spc_a",
        },
      ]),
    );
    const html = render(
      <>
        <ConversationRuns conversationId="chs_1" active {...RUNS_PROPS} />
        <ConversationFiles conversationId="chs_1" active onSelect={noop} />
      </>,
      queryClient,
    );
    expect(html).toContain("#12");
    expect(html).toContain("rapport.pdf");
    expect(html).not.toContain(i18n.t("common:error.generic"));
  });
});

describe("the Runs tab, open", () => {
  const AGENT = {
    id: "@acme/reporter",
    display_name: "Reporter",
    icon: null,
    color: null,
    integrations: [{ id: "@acme/gmail", name: "Gmail", icon: null }],
  };

  /** The Runs tab once its runs read answered with `runs`, `openRunId` open. */
  function runsTab(
    runs: unknown[],
    { openRunId = null, missing = false }: { openRunId?: string | null; missing?: boolean } = {},
  ): string {
    const queryClient = memberSpaceClient(spaces);
    queryClient.setQueryData(runsKey, list(runs));
    return render(
      <ConversationRuns
        conversationId="chs_1"
        active
        {...RUNS_PROPS}
        openRunId={openRunId}
        missing={missing}
      />,
      queryClient,
    );
  }

  it("draws a run as the thread's run line does: its agent, its number, its outcome, folded", () => {
    const html = runsTab([makeRun({ runNumber: 7, package_ephemeral: false })]);
    expect(rowsOf(html)).toBe(1);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).toContain("#7");
    expect(html).toContain(i18n.t("chat:run.status.success"));
    expect(html).toContain(formatDuration(4200));
    expect(html).not.toContain(i18n.t("chat:context.showInThread"));
  });

  it("follows its agent's name with its integrations once the agents' index answers", () => {
    const queryClient = memberSpaceClient(spaces);
    queryClient.setQueryData(runsKey, list([makeRun({ package_ephemeral: false })]));
    const tab = <ConversationRuns conversationId="chs_1" active {...RUNS_PROPS} />;
    // The first render builds the index's read; its answer is seeded under the key it built.
    render(tab, queryClient);
    const agents = queryClient.getQueryCache().findAll({ queryKey: ["agents"] });
    expect(agents.length).toBe(1);
    queryClient.setQueryData(agents[0]!.queryKey, [AGENT]);
    const html = render(tab, queryClient);
    expect(html).toContain("Reporter");
    expect(html).toContain('data-testid="integration-logo-stack"');
    expect(html.indexOf("integration-logo-stack")).toBeGreaterThan(html.indexOf("Reporter"));
  });

  it("says a failed run's own error on its line and in its detail", () => {
    const run = makeRun({ id: "run_x", status: "failed", error: "quota exceeded" });
    expect(runsTab([run])).toContain("quota exceeded");
    const open = runsTab([run], { openRunId: "run_x" });
    expect(open).toContain(i18n.t("chat:context.runs.error"));
  });

  it("holds the run it opens open on its line: its way to the thread, its result", () => {
    const html = runsTab(
      [
        makeRun({ id: "run_a", result: { output: { total: 3 } } }),
        makeRun({ id: "run_b", runNumber: 43 }),
      ],
      { openRunId: "run_a" },
    );
    expect(html.split('aria-expanded="true"').length - 1).toBe(1);
    expect(html.split('aria-expanded="false"').length - 1).toBe(1);
    expect(html).toContain(i18n.t("chat:context.showInThread"));
    expect(html).toContain(i18n.t("chat:context.runs.result"));
    expect(html).toContain("total");
    expect(html).not.toContain(i18n.t("chat:context.runs.notInThread"));
  });

  it("says under the open run that the last reveal found no card", () => {
    const html = runsTab([makeRun()], { openRunId: "run_1", missing: true });
    expect(html.split(i18n.t("chat:context.runs.notInThread")).length - 1).toBe(1);
  });

  it("offers to cancel a running run only where the reader may cancel runs", () => {
    const running = makeRun({ status: "running", runOrigin: "platform" });
    expect(runsTab([running], { openRunId: "run_1" })).not.toContain(
      `>${i18n.t("chat:context.runs.cancel")}<`,
    );
    const queryClient = memberSpaceClient([
      testSpace("spc_a", ["chat:read", "runs:read", "runs:cancel"]),
    ]);
    queryClient.setQueryData(runsKey, list([{ ...running, spaceId: "spc_a" }]));
    const html = render(
      <ConversationRuns conversationId="chs_1" active {...RUNS_PROPS} openRunId="run_1" />,
      queryClient,
    );
    expect(html).toContain(i18n.t("chat:context.runs.cancel"));
  });
});
