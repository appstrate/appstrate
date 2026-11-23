// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's model list disables only a dead model. A model nothing pays
 * for yet (`billed_to: null`) stays pickable with its reason, as the store keeps
 * it selected (`model-store-generation.test.ts`): the server answers its turn
 * with the "add your key" path. The dashboard's default (every blocked model
 * disabled) is pinned alongside, so the chat's option cannot leak into it.
 */

import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPickerList } from "@appstrate/ui/components/model-picker";
import { groupModelsForPicker } from "@appstrate/ui/components/model-picker-groups";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import { isModelSelectable } from "@appstrate/core/model-selectable";

import { ModelPanel } from "../src/ui/model-select.tsx";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

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

/** Each item's label → its markup (SSR renders no `data-value`). */
function itemsByLabel(html: string): Record<string, string> {
  const items = html.split(/(?=<div[^>]*cmdk-item="")/).slice(1);
  return Object.fromEntries(
    items.map((item) => [
      /<span class="truncate[^"]*">([^<]+)<\/span>/.exec(item)?.[1] ?? "",
      item,
    ]),
  );
}

/** Each item's label → whether cmdk marks it disabled. */
function disabledByLabel(html: string): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(itemsByLabel(html)).map(([label, item]) => [
      label,
      /^<div[^>]*data-disabled="true"/.test(item),
    ]),
  );
}

describe("composer model list", () => {
  it("uses settings translations for picker labels and interpolates the translated reasoning level", () => {
    const t = mock((key: string) => key);
    renderToStaticMarkup(
      <ChatHostProvider value={testHost({ t })}>
        <ModelPanel
          models={[{ ...live, apiShape: null }]}
          selectedId={live.id}
          onSelect={() => {}}
          generation={{}}
          onGenerationChange={() => {}}
          view="models"
          onViewChange={() => {}}
        />
      </ChatHostProvider>,
    );
    expect(t).toHaveBeenCalledWith("settings:modelPicker.search", undefined);
    expect(t).toHaveBeenCalledWith("settings:models.generation.reasoningHint", {
      level: "settings:models.generation.levels.medium",
    });
  });

  it("keeps a model nothing pays for pickable, with its reason, and disables a dead one", () => {
    const html = renderToStaticMarkup(
      <ModelPickerList
        groups={groups}
        value={null}
        onSelect={() => {}}
        labels={labels}
        selectable={isModelSelectable}
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

  it("sets the host's note under the name of the models it flags", () => {
    const html = renderToStaticMarkup(
      <ModelPickerList
        groups={groups}
        value={null}
        onSelect={() => {}}
        labels={labels}
        renderNote={(model) => (model.id === "live" ? <i>outgrown</i> : null)}
      />,
    );
    expect(html.match(/<i>outgrown<\/i>/g)).toHaveLength(1);
    const gpt = itemsByLabel(html).GPT;
    expect(gpt).toContain("<i>outgrown</i>");
  });
});

describe("a model row's action", () => {
  it("draws the host's control at the end of each row, and nothing without one", () => {
    const withAction = renderToStaticMarkup(
      <ModelPickerList
        groups={groups}
        value={null}
        onSelect={() => {}}
        labels={labels}
        selectable={isModelSelectable}
        rowAction={(model) => <button data-testid="row-action" data-model={model.id} />}
      />,
    );
    expect(withAction.match(/data-testid="row-action"/g)).toHaveLength(3);
    expect(withAction).toContain('data-model="live"');
    const without = renderToStaticMarkup(
      <ModelPickerList
        groups={groups}
        value={null}
        onSelect={() => {}}
        labels={labels}
        selectable={isModelSelectable}
      />,
    );
    expect(without).not.toContain("row-action");
  });
});
