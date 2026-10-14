// SPDX-License-Identifier: Apache-2.0

/**
 * A model's connection test words a dead key as the model's, never as the generic
 * « reconnect your integration » sentence the same code carries elsewhere.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import { render } from "../../../test/render.tsx";
import { ModelTestResult } from "../model-test-result.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("ModelTestResult", () => {
  it("says the model's key is unusable on a reconnection refusal", () => {
    const html = render(
      <ModelTestResult result={{ ok: false, latency: 0, error: "NEEDS_RECONNECTION" }} />,
    );
    expect(html).toContain(settingsFr["models.credentialUnavailableHint"]);
    expect(html).toContain("text-destructive");
  });

  it("reports any other outcome as every credential test does", () => {
    const ok = render(<ModelTestResult result={{ ok: true, latency: 42 }} />);
    expect(ok).toContain(settingsFr["credentials.testSuccess"].replace("{{latency}}", "42"));
    const failed = render(
      <ModelTestResult result={{ ok: false, latency: 0, message: "timeout" }} />,
    );
    expect(failed).toContain(
      settingsFr["credentials.testFailed"].replace("{{message}}", "timeout"),
    );
    expect(failed).not.toContain(settingsFr["models.credentialUnavailableHint"]);
  });
});
