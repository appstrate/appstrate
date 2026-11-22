// SPDX-License-Identifier: Apache-2.0

/**
 * The directive chip's pieces: the composer's remove button deletes that chip's node only, and an
 * agent's glyph is the tile of the commands entry its prompt name finds, the bot icon otherwise.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { $isDirectiveNode, DirectiveNode, $createDirectiveNode } from "@assistant-ui/react-lexical";
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  type ElementNode,
  createEditor,
  type LexicalEditor,
} from "lexical";

import type { ChatCommands } from "../src/commands.ts";
import { agentByPromptName } from "../src/ui/agent-appearance.ts";
import { AgentGlyph } from "../src/ui/agent-glyph.tsx";
import { $removeDirectiveChip } from "../src/ui/directive-chip-remove.ts";
import { DirectiveChip, DirectiveText } from "../src/ui/directive-chip.tsx";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

const commands: ChatCommands = {
  skills: [],
  agents: [
    {
      name: "run-report",
      title: "Weekly report",
      description: "",
      packageId: "@acme/report",
      icon: "lucide:chart-bar",
      color: "blue",
    },
  ],
};

function editorWithChips(): { editor: LexicalEditor; keys: string[] } {
  const editor = createEditor({
    nodes: [DirectiveNode],
    onError: (error) => {
      throw error;
    },
  });
  const keys: string[] = [];
  editor.update(
    () => {
      const p = $createParagraphNode();
      for (const name of ["tone", "pdf"]) {
        const chip = $createDirectiveNode({ id: `@acme/${name}`, type: "skill", label: name });
        keys.push(chip.getKey());
        p.append($createTextNode("a "), chip);
      }
      $getRoot().append(p);
    },
    { discrete: true },
  );
  return { editor, keys };
}

const texts = (editor: LexicalEditor) =>
  editor.read(() => $getRoot().getTextContent().replace(/\n/g, ""));

describe("removing a chip from the composer", () => {
  it("deletes that chip's node and leaves the other and the text", () => {
    const { editor, keys } = editorWithChips();
    editor.update(() => void $removeDirectiveChip($getNodeByKey(keys[0]!)), { discrete: true });
    const left = editor.read(() =>
      $getRoot().getAllTextNodes().length >= 0
        ? $getRoot()
            .getFirstChildOrThrow<ElementNode>()
            .getChildren()
            .filter($isDirectiveNode)
            .map((n) => n.getDirectiveItem().label)
        : [],
    );
    expect(left).toEqual(["pdf"]);
    expect(texts(editor)).toContain(":skill[pdf]{name=@acme/pdf}");
    expect(texts(editor)).not.toContain("tone");
    expect(texts(editor).match(/a /g)).toHaveLength(2);
  });

  it("does nothing for a node that is not a chip", () => {
    const { editor } = editorWithChips();
    let removed = true;
    editor.update(
      () => {
        removed = $removeDirectiveChip($createTextNode("x"));
      },
      { discrete: true },
    );
    expect(removed).toBe(false);
    expect(texts(editor)).toContain("tone");
  });

  it("draws the X in the composer only, named by its label, out of the tab order", () => {
    const remove = { label: "Remove tone", onRemove: () => {} };
    const inComposer = renderToString(
      <DirectiveChip directiveType="skill" directiveId="@acme/tone" label="tone" remove={remove} />,
    );
    expect(inComposer).toContain('aria-label="Remove tone"');
    expect(inComposer).toContain('tabindex="-1"');
    const sent = renderToString(<DirectiveText text=":skill[tone]{name=@acme/tone}" />);
    expect(sent).not.toContain("directive-chip-remove");
  });
});

describe("an agent's glyph", () => {
  it("finds the commands entry by prompt name", () => {
    expect(agentByPromptName(commands, "run-report")?.packageId).toBe("@acme/report");
    expect(agentByPromptName(commands, "run-gone")).toBeUndefined();
    expect(agentByPromptName(undefined, "run-report")).toBeUndefined();
  });

  it("is the bot icon without an entry, the tile with one", () => {
    const bot = renderToString(<AgentGlyph agent={undefined} label="Weekly report" />);
    expect(bot).toContain("lucide-bot");
    expect(bot).not.toContain("data-slot");
    const tile = renderToString(<AgentGlyph agent={commands.agents[0]} label="Weekly report" />);
    expect(tile).not.toContain("lucide-bot");
    expect(tile).toContain("size-4");
  });

  it("is drawn by a sent chip from the cached commands, the bot icon when they are not loaded", () => {
    const text = ":agent[Weekly report]{name=run-report}";
    const page = (client: QueryClient) =>
      renderToString(
        <QueryClientProvider client={client}>
          <ChatHostProvider value={testHost()}>
            <DirectiveText text={text} />
          </ChatHostProvider>
        </QueryClientProvider>,
      );
    expect(page(new QueryClient())).toContain("lucide-bot");
    const loaded = new QueryClient();
    loaded.setQueryData(["packages", "chat-commands", undefined, null], commands);
    expect(page(loaded)).not.toContain("lucide-bot");
  });
});
