// SPDX-License-Identifier: Apache-2.0

/**
 * A saved conversation's wait stands where the thread will: its 42rem column,
 * then a writer's composer and the line under it, or a reader's read-only note.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";

import { ConversationSkeleton } from "../src/ui/conversation-skeleton.tsx";

describe("ConversationSkeleton", () => {
  it("draws the turns in the thread's 42rem column, announced once", () => {
    const html = renderToString(<ConversationSkeleton label="Chargement" placeholder="Écrire" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Chargement"');
    expect(html).toContain("max-w-2xl");
    expect(html).not.toContain("max-w-3xl");
  });

  it("gives a writer the composer, its placeholder and the line under it", () => {
    const html = renderToString(<ConversationSkeleton label="Chargement" placeholder="Écrire" />);
    expect(html).toContain("Écrire");
    expect(html).toContain("min-h-9");
    expect(html).toContain("w-64");
    expect(html).not.toContain("h-[46px]");
  });

  it("gives a reader the read-only note's box, not a composer", () => {
    const html = renderToString(<ConversationSkeleton label="Chargement" placeholder={null} />);
    expect(html).toContain("h-[46px]");
    expect(html).not.toContain("min-h-9");
  });
});
