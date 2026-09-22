// SPDX-License-Identifier: Apache-2.0

/**
 * The renderer knows nothing about SSH, so what is pinned is the contract:
 * each kind renders its payload, in the order received, and a deferred step is
 * collapsed but present — dropped, the removal command would exist nowhere.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { HandoffSteps, type HandoffStep } from "../handoff-steps.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

/**
 * Ids the bundle carries no key for, on purpose: the structural assertions
 * below then read the server's own text, and the localisation suite at the
 * bottom owns both halves of the lookup.
 */
const STEPS: HandoffStep[] = [
  {
    id: "demo_install",
    kind: "command",
    label: "Paste this on the target server",
    shell: "set -eu\ninstall -d ~agent/.ssh",
  },
  {
    id: "demo_fingerprint",
    kind: "value",
    label: "Host fingerprint, pinned",
    value: "SHA256:YJK+IkPvWMR1nIl8CmsNEzIxSKBBIAZkrizRiuynnbw",
    note: "If it differs, the pinned key is not this server's.",
  },
  {
    id: "demo_revoke",
    kind: "command",
    label: "Remove this key later",
    shell: "grep -vF 'AAAA' ~agent/.ssh/authorized_keys",
    deferred: true,
    note: "Keep this block.",
  },
];

describe("HandoffSteps", () => {
  it("renders nothing when there is no step", () => {
    expect(render(<HandoffSteps steps={[]} />)).toBe("");
  });

  it("renders a command step's shell verbatim, with a copy affordance", () => {
    const markup = render(<HandoffSteps steps={[STEPS[0]!]} />);
    expect(markup).toContain("Paste this on the target server");
    expect(markup).toContain("install -d ~agent/.ssh");
    expect(markup).toContain('data-testid="handoff-step-0"');
    expect(markup).toContain("<button");
  });

  it("renders a value step's value and its note", () => {
    const markup = render(<HandoffSteps steps={[STEPS[1]!]} />);
    expect(markup).toContain("SHA256:YJK+IkPvWMR1nIl8CmsNEzIxSKBBIAZkrizRiuynnbw");
    expect(markup).toContain("the pinned key is not this server");
  });

  it("keeps a deferred step on the page, collapsed rather than dropped", () => {
    const markup = render(<HandoffSteps steps={STEPS} />);
    expect(markup).toContain("<details");
    expect(markup).toContain("Remove this key later");
    expect(markup).toContain("grep -vF");
  });

  it("renders the steps in the order received", () => {
    const markup = render(<HandoffSteps steps={STEPS} />);
    const now = markup.indexOf("Paste this on the target server");
    const fingerprint = markup.indexOf("Host fingerprint, pinned");
    const later = markup.indexOf("<details");
    expect(now).toBeGreaterThanOrEqual(0);
    expect(fingerprint).toBeGreaterThan(now);
    expect(later).toBeGreaterThan(fingerprint);
  });

  it("does not repeat the label inside a collapsed step", () => {
    const markup = render(<HandoffSteps steps={[STEPS[2]!]} />);
    expect(markup.split("Remove this key later")).toHaveLength(2);
  });
});

/**
 * A step's prose is the server's English until the bundle has a key for its
 * `id`. Both directions matter: a kind the SPA has never heard of stays
 * legible, and the one it ships keys for reads in the user's language. The
 * harness renders in French.
 */
describe("HandoffSteps — prose keyed on the step id", () => {
  it("renders the bundle text for an id it knows", () => {
    const known: HandoffStep = {
      id: "ssh_host_fingerprint",
      kind: "value",
      label: "Host fingerprint, pinned",
      value: "SHA256:YJK+IkPvWMR1nIl8CmsNEzIxSKBBIAZkrizRiuynnbw",
      note: "The command above prints the server's fingerprint as its last line.",
    };
    const markup = render(<HandoffSteps steps={[known]} />);

    expect(markup).toContain("Empreinte de l'hôte, épinglée");
    expect(markup).toContain("la clé d'hôte épinglée n'est pas celle de ce serveur");
    expect(markup).not.toContain("Host fingerprint, pinned");
  });

  it("falls back to the server's own text for an id it does not know", () => {
    // What a second provisioning kind looks like before anyone writes it a key.
    const unknown: HandoffStep = {
      id: "mtls_install",
      kind: "command",
      label: "Install the client certificate",
      shell: "cp client.pem /etc/ssl/private/",
      note: "The chain matters as much as the leaf.",
    };
    const markup = render(<HandoffSteps steps={[unknown]} />);

    expect(markup).toContain("Install the client certificate");
    expect(markup).toContain("The chain matters as much as the leaf.");
  });

  it("renders the revoke note in the shape the teardown confirmation receives", () => {
    // `/handoff` sends the removal step without `deferred`: it is the whole
    // list there, so it renders open, note included, not collapsed.
    const teardown: HandoffStep = {
      id: "ssh_revoke",
      kind: "command",
      label: "Remove this key from the server",
      shell: "grep -vF 'AAAA' ~agent/.ssh/authorized_keys",
      note: "Keep this block.",
    };
    const markup = render(<HandoffSteps steps={[teardown]} />);

    expect(markup).not.toContain("<details");
    expect(markup).toContain("lancez-le avant ou après la suppression");
  });

  it("renders no note when the server sent none, key or no key", () => {
    // `ssh_revoke` HAS a note key. A step arriving without a note must not grow
    // one out of the bundle.
    const noNote: HandoffStep = {
      id: "ssh_revoke",
      kind: "command",
      label: "Remove this key from the server",
      shell: "grep -vF 'AAAA' ~agent/.ssh/authorized_keys",
    };
    const markup = render(<HandoffSteps steps={[noNote]} />);

    expect(markup).toContain("Retirer cette clé du serveur");
    expect(markup).not.toContain("Gardez ce bloc");
  });
});
