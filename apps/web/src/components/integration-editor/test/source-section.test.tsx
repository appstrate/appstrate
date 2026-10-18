// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { SourceSection } from "../source-section.tsx";

await i18nReady;

const remote = { source: { kind: "remote", remote: { url: "https://x.test/mcp" } } };
const discovery = { onProposal: () => {}, badges: {}, warnings: [] };
const analyse = 'data-testid="integration-editor-analyse"';

describe("SourceSection analyse button", () => {
  it("is offered on creation for a remote source", () => {
    const html = render(
      <SourceSection manifest={remote} onChange={() => {}} discovery={discovery} />,
    );
    expect(html).toContain(analyse);
    expect(html).toContain("Analyser");
  });

  it("is hidden when editing", () => {
    expect(render(<SourceSection manifest={remote} onChange={() => {}} />)).not.toContain(analyse);
  });

  it("is hidden for a local source", () => {
    const local = { source: { kind: "local", server: { name: "s" } } };
    const html = render(
      <SourceSection manifest={local} onChange={() => {}} discovery={discovery} />,
    );
    expect(html).not.toContain(analyse);
  });

  it("shows the badge on the transport and the translated warning", () => {
    const html = render(
      <SourceSection
        manifest={remote}
        onChange={() => {}}
        discovery={{
          onProposal: () => {},
          badges: { "/source/remote/transport": "guessed" },
          warnings: [{ code: "manual_client_required", message: "en" }],
        }}
      />,
    );
    expect(html).toContain("suggéré");
    expect(html).toContain("enregistrement dynamique");
  });
});
