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
    for (const event of [
      "run.started",
      "run.success",
      "run.failed",
      "run.timeout",
      "run.cancelled",
      "run.connection_missing",
    ]) {
      expect(html).toContain(`event-${event}`);
    }
  });
});
