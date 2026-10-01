// SPDX-License-Identifier: Apache-2.0

/**
 * The `ask_user` tool (`pi-chat/ask-user.ts`): it waits for the person's reply
 * and hands it to the model as-is, always with an explicit status; and the
 * reply registry only lets a reply of the right kind through.
 */

import { describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import {
  ASK_USER_TOOL,
  createAskUserExtension,
  type RequestAnswers,
} from "../src/pi-chat/ask-user.ts";
import type { AskUserReply } from "../src/ask-user-reply.ts";
import { awaitReply, resolveReply } from "../src/reply-registry.ts";

interface RegisteredTool {
  name: string;
  parameters: { properties: { questions: { minItems: number; maxItems: number } } };
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function register(requestAnswers: RequestAnswers): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const pi = { registerTool: (t: RegisteredTool) => (tool = t) } as unknown as ExtensionAPI;
  createAskUserExtension(requestAnswers)(pi);
  return tool!;
}

const QUESTIONS = {
  questions: [
    {
      id: "target",
      header: "Cible",
      question: "Quel agent modifier ?",
      options: [{ label: "Relances (Recommandé)" }, { label: "Veille" }],
    },
    { id: "note", header: "Note", question: "Une précision ?" },
  ],
};

describe("ask_user tool", () => {
  it("asks 1 to 4 questions", () => {
    const tool = register(async () => ({ status: "cancelled" }));
    expect(tool.name).toBe(ASK_USER_TOOL);
    expect(tool.parameters.properties.questions.minItems).toBe(1);
    expect(tool.parameters.properties.questions.maxItems).toBe(4);
  });

  it("waits for the reply, then hands the model exactly what the person answered", async () => {
    let answer: ((reply: AskUserReply) => void) | undefined;
    const asked: string[] = [];
    const tool = register((toolCallId) => {
      asked.push(toolCallId);
      return new Promise((resolve) => (answer = resolve));
    });

    let settled = false;
    const pending = tool.execute("call_1", QUESTIONS).then((r) => {
      settled = true;
      return r;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(asked).toEqual(["call_1"]);

    const reply: AskUserReply = {
      status: "answered",
      answers: { target: { selected: ["Veille"] }, note: { selected: [], text: "sans urgence" } },
    };
    answer!(reply);
    expect(JSON.parse((await pending).content[0]!.text)).toEqual(reply);
  });

  it("reports a skip explicitly", async () => {
    const tool = register(async () => ({ status: "cancelled" }));
    const result = await tool.execute("call_2", QUESTIONS);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ status: "cancelled" });
  });

  it("refuses two questions with the same id, before asking anything", async () => {
    const asked: string[] = [];
    const tool = register(async (id) => {
      asked.push(id);
      return { status: "cancelled" };
    });
    const twice = { questions: [QUESTIONS.questions[1], QUESTIONS.questions[1]] };
    await expect(tool.execute("call_3", twice)).rejects.toThrow(/its own id/);
    expect(asked).toEqual([]);
  });
});

describe("reply registry", () => {
  it("lets only a reply of the waiting kind through", async () => {
    const turn = new AbortController();
    const waiting = awaitReply("question", "call_9", "chs_1", turn.signal, { status: "cancelled" });
    expect(resolveReply("approval", "call_9", "chs_1", { approved: true })).toBe(false);
    expect(resolveReply("question", "call_9", "chs_1", { status: "cancelled" })).toBe(true);
    expect(await waiting).toEqual({ status: "cancelled" });
  });

  it("settles a question as cancelled when the turn ends without an answer", async () => {
    const turn = new AbortController();
    const waiting = awaitReply("question", "call_10", "chs_1", turn.signal, {
      status: "cancelled",
    });
    turn.abort();
    expect(await waiting).toEqual({ status: "cancelled" });
  });
});
