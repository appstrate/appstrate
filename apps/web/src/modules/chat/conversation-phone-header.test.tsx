// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's phone header, after the shell's burger: the conversation's name, the pencil that
 * edits it, the context panel. Thumb-sized controls; a new conversation has a name to show and
 * nothing to rename.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { renderInSpace, memberSpaceClient } = await import("../../test/space-context.ts");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { ConversationPhoneBar } = await import("./conversation-phone-header.tsx");

await i18nReady;
await i18n.changeLanguage("fr");
await i18n.loadNamespaces(["chat"]);

function render(conversationId: string | null) {
  return renderInSpace(
    <ConversationPhoneBar
      conversationId={conversationId}
      transport={undefined}
      translate={(key) => key}
      can={() => true}
      expanded={false}
      dispatch={() => {}}
    />,
    { queryClient: memberSpaceClient([]), overview: false },
  );
}

describe("the chat's phone header", () => {
  it("names a new conversation and has nothing to rename", () => {
    const html = render(null);
    expect(html).toContain('data-testid="conversation-phone-title"');
    expect(html).toContain("Nouvelle conversation");
    expect(html).not.toContain("Modifier le nom de la conversation");
  });

  it("truncates a long name rather than pushing the controls out", () => {
    const html = render(null);
    expect(html).toMatch(/<h1 class="[^"]*min-w-0[^"]*flex-1[^"]*truncate/);
  });

  it("ends on the context panel, as big as a thumb", () => {
    const html = render(null);
    expect(html).toContain('aria-label="Afficher le contexte"');
    expect(html).toMatch(/class="[^"]*size-11[^"]*"[^>]*aria-label="Afficher le contexte"/);
  });

  it("holds the place of a stored conversation's name until it is read, with no pencil yet", () => {
    const html = render("chs_1");
    expect(html).not.toContain('data-testid="conversation-phone-title"');
    expect(html).not.toContain("Modifier le nom de la conversation");
  });
});
