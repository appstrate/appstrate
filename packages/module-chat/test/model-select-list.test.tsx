// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's model list disables only a dead model. A model nothing pays
 * for yet (`billed_to: null`) stays pickable with its reason, as the store keeps
 * it selected (`model-store-generation.test.ts`): the server answers its turn
 * with the "add your key" path. The dashboard's default (every blocked model
 * disabled) is pinned alongside, so the chat's option cannot leak into it.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPickerList } from "@appstrate/ui/components/model-picker";
import { groupModelsForPicker } from "@appstrate/ui/components/model-picker-groups";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import { isModelLive } from "../src/model-liveness.ts";

const unpaid = {
  id: "unpaid",
  label: "Claude",
  modelId: "claude-sonnet",
  provider_name: "Anthropic",
  binding: "user" as const,
  billed_to: null,
};
const dead = {
  id: "dead",
  label: "Mistral",
  modelId: "mistral-medium",
  binding: "org" as const,
  billed_to: "org" as const,
  credentialId: "cred_org",
  needs_reconnection: true,
};
const live = { ...dead, id: "live", label: "GPT", needs_reconnection: false };

const groups = groupModelsForPicker([unpaid, dead, live], { canConnect: true });
const labels = buildModelPickerLabels((key) => key);

/** Each item's label → whether cmdk marks it disabled (SSR renders no `data-value`). */
function disabledByLabel(html: string): Record<string, boolean> {
  const items = html.split(/(?=<div[^>]*cmdk-item="")/).slice(1);
  return Object.fromEntries(
    items.map((item) => [
      /<span class="truncate[^"]*">([^<]+)<\/span>/.exec(item)?.[1] ?? "",
      /^<div[^>]*data-disabled="true"/.test(item),
    ]),
  );
}

describe("composer model list", () => {
  it("keeps a model nothing pays for pickable, with its reason, and disables a dead one", () => {
    const html = renderToStaticMarkup(
      <ModelPickerList
        groups={groups}
        value={null}
        onSelect={() => {}}
        labels={labels}
        selectable={isModelLive}
      />,
    );
    expect(disabledByLabel(html)).toEqual({ Claude: false, Mistral: true, GPT: false });
    expect(html).toContain("modelPicker.reason.personalRequired");
  });

  it("disables every blocked model by default (the dashboard's pickers)", () => {
    const html = renderToStaticMarkup(
      <ModelPickerList groups={groups} value={null} onSelect={() => {}} labels={labels} />,
    );
    expect(disabledByLabel(html)).toEqual({ Claude: true, Mistral: true, GPT: false });
  });
});
