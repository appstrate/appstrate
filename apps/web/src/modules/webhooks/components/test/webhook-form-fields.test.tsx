// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { i18nReady } from "@/i18n.ts";
import { render } from "@/test/render.tsx";
import { WebhookFormFields } from "../webhook-form-fields.tsx";

await i18nReady;

describe("WebhookFormFields", () => {
  it("offers every event the API accepts, run.connection_missing included", () => {
    const html = render(
      <WebhookFormFields
        selectedEvents={[]}
        onToggleEvent={() => {}}
        payloadMode="full"
        onPayloadModeChange={() => {}}
      />,
    );
    expect(html).toContain("event-run.connection_missing");
  });
});
