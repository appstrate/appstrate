// SPDX-License-Identifier: Apache-2.0

/**
 * The handoff list is the screen a user reads while a minted credential is half
 * installed, and the whole point of making it DATA is that this renderer knows
 * nothing about SSH. So what is pinned here is the contract, not the wording:
 * each kind renders its payload, and a deferred step is present but out of the
 * way — if it were dropped, the removal command would exist nowhere and the key
 * would live on the target forever.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { HandoffSteps, type HandoffStep } from "../handoff-steps.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const STEPS: HandoffStep[] = [
  {
    kind: "command",
    label: "À coller sur le serveur cible",
    shell: "set -eu\ninstall -d ~agent/.ssh",
  },
  {
    kind: "value",
    label: "Empreinte de l'hôte, épinglée",
    value: "SHA256:YJK+IkPvWMR1nIl8CmsNEzIxSKBBIAZkrizRiuynnbw",
    note: "Si elle diffère, quelqu'un s'est intercalé.",
  },
  {
    kind: "command",
    label: "Retirer cette clé plus tard",
    shell: "grep -vF 'AAAA' ~agent/.ssh/authorized_keys",
    deferred: true,
    note: "Gardez ce bloc.",
  },
];

describe("HandoffSteps", () => {
  it("renders nothing when there is no step", () => {
    expect(render(<HandoffSteps steps={[]} />)).toBe("");
  });

  it("renders a command step's shell verbatim, with a copy affordance", () => {
    const markup = render(<HandoffSteps steps={[STEPS[0]!]} />);
    expect(markup).toContain("À coller sur le serveur cible");
    expect(markup).toContain("install -d ~agent/.ssh");
    expect(markup).toContain('data-testid="handoff-copy-0"');
  });

  it("renders a value step's value and its note", () => {
    const markup = render(<HandoffSteps steps={[STEPS[1]!]} />);
    expect(markup).toContain("SHA256:YJK+IkPvWMR1nIl8CmsNEzIxSKBBIAZkrizRiuynnbw");
    expect(markup).toContain("Si elle diffère");
  });

  /**
   * The teardown block is the one the literature says this whole approach
   * loses — "revoking requires remembering it exists". Collapsed is fine;
   * absent is not.
   */
  it("keeps a deferred step on the page, collapsed rather than dropped", () => {
    const markup = render(<HandoffSteps steps={STEPS} />);
    expect(markup).toContain("<details");
    expect(markup).toContain("Retirer cette clé plus tard");
    expect(markup).toContain("grep -vF");
  });

  it("orders the steps to do now before the deferred one", () => {
    const markup = render(<HandoffSteps steps={STEPS} />);
    const now = markup.indexOf("À coller sur le serveur cible");
    const fingerprint = markup.indexOf("Empreinte de l'hôte");
    const later = markup.indexOf("<details");
    expect(now).toBeGreaterThanOrEqual(0);
    expect(fingerprint).toBeGreaterThan(now);
    expect(later).toBeGreaterThan(fingerprint);
  });

  it("does not repeat the label inside a collapsed step", () => {
    const markup = render(<HandoffSteps steps={[STEPS[2]!]} />);
    expect(markup.split("Retirer cette clé plus tard")).toHaveLength(2);
  });
});
