// SPDX-License-Identifier: Apache-2.0

/**
 * What the agent page's header handed to the overview tab: the description and
 * where the agent comes from. The block says nothing about an ordinary local
 * agent with no description, and names a system agent as read-only.
 */

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { AgentIdentity } from "../agent-identity.tsx";

await i18nReady;

describe("AgentIdentity", () => {
  it("draws nothing for a local agent with no description and no readable home", () => {
    expect(render(<AgentIdentity description="" source="local" homeSpaceName={null} />)).toBe("");
  });

  it("opens with the description", () => {
    const html = render(
      <AgentIdentity description="Résume les courriels" source="local" homeSpaceName={null} />,
    );
    expect(html).toContain("Résume les courriels");
    expect(html).not.toContain("<dl");
  });

  it("names the home space the reader can enter", () => {
    const html = render(<AgentIdentity description="" source="local" homeSpaceName="Marketing" />);
    expect(html).toContain("Marketing");
    expect(html).toContain("<dl");
  });

  it("says a system agent's bundle is read-only", () => {
    const html = render(<AgentIdentity description="" source="system" homeSpaceName={null} />);
    expect(html).toContain("Agent système");
    expect(html).toContain("lecture seule");
  });
});
