// SPDX-License-Identifier: Apache-2.0

/**
 * A provider key passes its test as soon as the probe request gets past the key
 * check, whatever the provider then answers (`validateKeyByInference`). The
 * result line must not turn a 400 into the same green "OK" a 200 gets.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { TestResultSpan } = await import("../test-result-span.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function line(result: Parameters<typeof TestResultSpan>[0]["result"]): string {
  return render(
    <TestResultSpan
      result={result}
      successKey="models.testSuccess"
      failedKey="models.testFailed"
    />,
  );
}

describe("TestResultSpan", () => {
  it("names the upstream status of a key accepted on a non-2xx answer", () => {
    const html = line({ ok: true, latency: 262, status: 400 });
    expect(html).toContain("Le provider a répondu 400 (262ms)");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("OK (");
  });

  it("keeps the green OK for a 2xx and for a test that made no request", () => {
    for (const result of [
      { ok: true, latency: 425, status: 200 },
      { ok: true, latency: 0 },
    ]) {
      const html = line(result);
      expect(html).toContain(`OK (${result.latency}ms)`);
      expect(html).toContain("text-green-500");
    }
  });

  it("renders a failure with its message", () => {
    const html = line({ ok: false, latency: 3, message: "Authentication failed", status: 401 });
    expect(html).toContain("Échec : Authentication failed");
    expect(html).toContain("text-destructive");
  });
});
