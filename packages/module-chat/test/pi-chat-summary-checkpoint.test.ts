// SPDX-License-Identifier: Apache-2.0

/**
 * A summary Pi made on an earlier turn is replayed instead of the history it replaces
 * (`AppstrateTurnMetadata.summary`), against the real Pi `SessionManager` the engine uses.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { dirname, join } from "node:path";
import type { UIMessage } from "ai";
import { loadPiCodingAgentSdk, type Api } from "@appstrate/runner-pi";
import { mergeTurnMetadata, type AppstrateTurnSummary } from "@appstrate/core/chat-turn-metadata";
import { logger } from "../src/logger.ts";
import {
  buildStructuredPiTurn,
  piSummaryTokens,
  reconstructPiSession,
  resolveSummaryCheckpoint,
  type PiHistoryModel,
} from "../src/pi-chat/structured-session.ts";

const sdk = await loadPiCodingAgentSdk();
const { estimateTokens, SessionManager } = sdk;
// Not exported by the SDK index: loaded from the package runner-pi resolves, beside its entry.
const sdkEntry = Bun.resolveSync(
  "@earendil-works/pi-coding-agent",
  dirname(Bun.resolveSync("@appstrate/runner-pi", import.meta.dir)),
);
const compaction = (await import(join(dirname(sdkEntry), "core/compaction/compaction.js"))) as {
  prepareCompaction: (
    entries: unknown[],
    settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
  ) => { previousSummary?: string; messagesToSummarize: unknown[] } | undefined;
  estimateProjectedContextTokens: (
    projection: unknown,
    branch: unknown[],
  ) => { tokens: number; lastUsageIndex: number | null };
};

const MODEL: PiHistoryModel = { api: "openai-completions" as Api, provider: "openai", model: "m" };
const OPTIONS = { estimateTokens, baseTokens: 0 };

const summary = (
  messageId: string,
  offset: number,
  text = "Résumé ancien",
): AppstrateTurnSummary => ({
  text,
  keptFrom: { messageId, offset },
  tokensBefore: 150_000,
});

const text = (id: string, role: "user" | "assistant", value: string, turn?: AppstrateTurnSummary) =>
  ({
    id,
    role,
    parts: [{ type: "text", text: value }],
    ...(turn
      ? {
          metadata: mergeTurnMetadata(undefined, {
            stepCount: 1,
            maxSteps: 16,
            maxStepsReached: false,
            summary: turn,
          }),
        }
      : {}),
  }) as UIMessage;

/** Projects as [assistant(toolCall), toolResult, assistant(text)]: offsets 0, 1, 2. */
const multiStep = {
  id: "a0",
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "search",
      toolCallId: "call_0",
      state: "output-available",
      input: { query: "ancien-appel" },
      output: { content: [{ type: "text", text: "ancien-resultat" }] },
    },
    { type: "step-start" },
    { type: "text", text: "réponse gardée" },
  ],
} as unknown as UIMessage;

const thread = (carrier: AppstrateTurnSummary | undefined): UIMessage[] => [
  text("u0", "user", "question résumée"),
  multiStep,
  text("u1", "user", "question gardée"),
  text("a1", "assistant", "réponse du tour qui a résumé", carrier),
  text("u2", "user", "nouvelle question"),
];

/** The branch's checkpoint, sized as the engine sizes it. */
function checkpointOf(branch: UIMessage[]) {
  const found = resolveSummaryCheckpoint(branch, MODEL);
  return found && { ...found, summaryTokens: piSummaryTokens(sdk, found.summary.text) };
}

function project(branch: UIMessage[]) {
  const turn = buildStructuredPiTurn(branch, MODEL, {
    ...OPTIONS,
    checkpoint: checkpointOf(branch),
  });
  return { turn, ...reconstructPiSession(SessionManager, turn) };
}

const contextText = (messages: unknown[]) => JSON.stringify(messages);

afterEach(() => {
  (logger.warn as { mockRestore?: () => void }).mockRestore?.();
});

describe("summary checkpoint projection", () => {
  it("sends the summary, then the kept history in order, and nothing before it", () => {
    const { session, turn } = project(thread(summary("a0", 2)));
    const messages = session.buildSessionContext().messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({ summary: "Résumé ancien" });
    const sent = contextText(messages);
    expect(sent).toContain("réponse gardée");
    expect(sent).not.toContain("question résumée");
    expect(sent).not.toContain("ancien-appel");
    expect(sent).not.toContain("ancien-resultat");
    expect(turn.origins).toEqual([
      { messageId: "a0", offset: 2 },
      { messageId: "u1", offset: 0 },
      { messageId: "a1", offset: 0 },
    ]);
  });

  it("maps every appended entry to its origin, and leaves the summary entry out", () => {
    const { session, origins } = project(thread(summary("a0", 2)));
    const branch = session.getBranch();
    expect(branch.map((entry) => entry.type)).toEqual([
      "message",
      "compaction",
      "message",
      "message",
    ]);
    expect(origins.get(branch[0]!.id)).toEqual({ messageId: "a0", offset: 2 });
    expect(origins.has(branch[1]!.id)).toBe(false);
    expect([...origins.values()].at(-1)).toEqual({ messageId: "a1", offset: 0 });
  });

  it("adds no system message: the system prompt is the session's own", () => {
    const { session } = project(thread(summary("a0", 2)));
    expect(session.buildSessionContext().messages.some((m) => m.role === "system")).toBe(false);
  });

  it("counts the summary in the starting estimate, not what it replaces", () => {
    const full = buildStructuredPiTurn(thread(undefined), MODEL, OPTIONS);
    const { turn } = project(thread(summary("a0", 2)));
    const kept = turn.history.reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(turn.contextTokens).toBe(piSummaryTokens(sdk, "Résumé ancien") + kept);
    expect(turn.contextTokens).not.toBe(full.contextTokens);
  });

  it("sizes the summary as Pi sends it, wrapped in its compaction message", () => {
    const [sent] = sdk.convertToLlm([
      { role: "compactionSummary", summary: "Résumé ancien", tokensBefore: 0, timestamp: 0 },
    ]);
    expect(JSON.stringify(sent)).toContain("<summary>");
    expect(piSummaryTokens(sdk, "Résumé ancien")).toBe(estimateTokens(sent!));
    expect(piSummaryTokens(sdk, "Résumé ancien")).toBeGreaterThan(
      estimateTokens({
        role: "user",
        content: [{ type: "text", text: "Résumé ancien" }],
        timestamp: 0,
      }),
    );
  });

  it("projects the whole branch when no turn on it summarized", () => {
    const branch = thread(undefined);
    expect(resolveSummaryCheckpoint(branch, MODEL)).toBeUndefined();
    const { session } = project(branch);
    expect(contextText(session.buildSessionContext().messages)).toContain("question résumée");
    expect(session.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("projects the whole branch, and says so, when the kept history is not on it", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const { session } = project(thread(summary("gone", 0)));
    expect(contextText(session.buildSessionContext().messages)).toContain("question résumée");
    expect(warn).toHaveBeenCalledWith(
      "chat summary ignored: its kept history is not on the branch",
      {
        carrierId: "a1",
      },
    );
  });

  it("projects the whole branch, and says why, when the summary metadata is malformed", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveSummaryCheckpoint(thread(summary("a0", -1)), MODEL)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("chat summary ignored: malformed summary metadata", {
      carrierId: "a1",
    });
  });

  it("projects the whole branch when the kept history starts past what its message projects", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const { session, turn } = project(thread(summary("a0", 3)));
    expect(turn.summary).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain("anchor offset is past");
    expect(contextText(session.buildSessionContext().messages)).toContain("question résumée");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("projects the whole branch when the kept history would start on a tool result", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    // Offset 1 of `a0` is the result of `call_0`: Pi never keeps history from there.
    const { session, turn } = project(thread(summary("a0", 1)));
    expect(turn.summary).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "chat summary ignored: its anchor offset lands on a tool result",
      {
        carrierId: "a1",
      },
    );
    expect(contextText(session.buildSessionContext().messages)).toContain("question résumée");
  });

  it("falls back to an older summary when the newest one's offset is past its message", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const branch: UIMessage[] = [
      ...thread(summary("a0", 2, "ancien résumé valide")).slice(0, -1),
      text("u2", "user", "question suivante"),
      text("a2", "assistant", "réponse", summary("a0", 7, "résumé à l'ancre invalide")),
      text("u3", "user", "dernière question"),
    ];
    expect(resolveSummaryCheckpoint(branch, MODEL)).toMatchObject({
      summary: { text: "ancien résumé valide" },
      anchorIndex: 1,
    });
    expect(warn.mock.calls[0]?.[0]).toContain("anchor offset is past");
  });

  it("never reads a summary whose kept history starts after the turn that made it", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveSummaryCheckpoint(thread(summary("u2", 0)), MODEL)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "chat summary ignored: its kept history starts after the turn that made it",
      { carrierId: "a1" },
    );
  });

  it("starts from the newest summary of the branch", () => {
    const branch: UIMessage[] = [
      ...thread(summary("a0", 2, "premier résumé")).slice(0, -1),
      text("u2", "user", "question suivante"),
      text("a2", "assistant", "réponse résumée deux fois", summary("u2", 0, "second résumé")),
      text("u3", "user", "dernière question"),
    ];
    const { session } = project(branch);
    const messages = session.buildSessionContext().messages;
    expect(messages[0]).toMatchObject({ summary: "second résumé" });
    expect(contextText(messages)).not.toContain("réponse gardée");
    expect(contextText(messages)).toContain("question suivante");
  });

  it("sends the summary alone when nothing before the turn is kept", () => {
    const failed: UIMessage[] = [
      text("u0", "user", "question résumée"),
      text("u1", "user", ""),
      {
        id: "a1",
        role: "assistant",
        parts: [],
        metadata: text("x", "assistant", "", summary("u1", 0)).metadata,
      } as UIMessage,
      text("u2", "user", "Réessaie"),
    ];
    const { session, turn } = project(failed);
    expect(turn.history).toEqual([]);
    expect(session.buildSessionContext().messages.map((m) => m.role)).toEqual([
      "compactionSummary",
    ]);
  });

  it("orders the kept assistants after the summary entry, so Pi trusts their usage", () => {
    const { session } = project(thread(summary("a0", 2)));
    const branch = session.getBranch();
    const estimate = compaction.estimateProjectedContextTokens(
      session.buildSessionProjection(),
      branch,
    );
    const lastAssistant = session
      .buildSessionContext()
      .messages.findLast((message) => message.role === "assistant");
    expect(estimate.lastUsageIndex).not.toBeNull();
    expect(estimate.tokens).toBe(
      lastAssistant?.role === "assistant" ? lastAssistant.usage.totalTokens : -1,
    );
  });

  it("stamps the kept history after the summary entry, past Pi's stale-usage guard", () => {
    const { session } = project(thread(summary("a0", 2)));
    const [firstKept, summaryEntry, ...rest] = session.getBranch();
    expect([firstKept?.type, summaryEntry?.type]).toEqual(["message", "compaction"]);
    const summarizedAt = Date.parse(summaryEntry!.timestamp);
    // `_checkCompaction` (agent-session.js): an assistant stamped at or before the latest
    // summary entry is "from before compaction" and its usage is never read.
    const stamps = rest.map((entry) => (entry.type === "message" ? entry.message.timestamp : NaN));
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps.every((stamp) => stamp > summarizedAt)).toBe(true);
    // One stamp, the first past the summary: a summary Pi makes later in the turn is never older.
    expect(new Set(stamps)).toEqual(new Set([summarizedAt + 1]));
  });

  it("gives Pi's next summary the previous one, and only the kept history to summarize", () => {
    const { session } = project(thread(summary("a0", 2)));
    const preparation = compaction.prepareCompaction(session.getBranch(), {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    });
    expect(preparation?.previousSummary).toBe("Résumé ancien");
    const summarized = contextText(preparation?.messagesToSummarize ?? []);
    expect(summarized).toContain("réponse gardée");
    expect(summarized).not.toContain("question résumée");
  });
});
