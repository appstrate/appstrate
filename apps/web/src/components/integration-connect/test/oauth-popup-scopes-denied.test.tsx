// SPDX-License-Identifier: Apache-2.0

/**
 * The connect popup's outcome as its opener hears it: a completion naming scopes the consent
 * left out is told to the user, a full consent is not.
 *
 * No DOM: `window` is a stub holding a fake popup, the session mint is stubbed on the typed
 * client, and the completion arrives on the real `BroadcastChannel` the callback page publishes on.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { toast } from "sonner";
import {
  INTEGRATION_CONNECT_CHANNEL,
  buildIntegrationConnectCompletion,
} from "@appstrate/core/connect-handshake";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "http://localhost" },
  open: () => ({ location: { href: "" }, closed: false, close: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
});

const { client } = await import("../../../api/client.ts");
const { render } = await import("../../../test/render.tsx");
const { useHostedConnectPopup } = await import("../use-integration-oauth-popup.ts");
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const PACKAGE = "@acme/mail";

function openPopup() {
  const captured: ReturnType<typeof useHostedConnectPopup>[] = [];
  function Probe() {
    captured.push(useHostedConnectPopup());
    return null;
  }
  render(<Probe />);
  return captured[0]!.openPopup({ packageId: PACKAGE, authKey: "primary" });
}

/** The callback page finishing the flow, once the opener listens. */
async function complete(scopesDenied?: string[]) {
  await Bun.sleep(0);
  const channel = new BroadcastChannel(INTEGRATION_CONNECT_CHANNEL);
  channel.postMessage(
    buildIntegrationConnectCompletion({ ok: true, packageId: PACKAGE, scopesDenied }),
  );
  channel.close();
}

let warned: ReturnType<typeof spyOn>;
let minted: ReturnType<typeof spyOn>;
beforeEach(() => {
  warned = spyOn(toast, "warning").mockImplementation(() => 0);
  minted = spyOn(client, "POST").mockResolvedValue({
    data: { connect_url: "http://localhost/connect/x" },
  });
});
afterEach(() => {
  warned.mockRestore();
  minted.mockRestore();
});

describe("connect popup — a partial consent", () => {
  it("names the scopes the consent left out", async () => {
    const done = openPopup();
    await complete(["mail.send", "mail.labels"]);

    expect(await done).toBe(true);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]![0]).toContain("mail.send, mail.labels");
  });

  it("says nothing after a full consent", async () => {
    const done = openPopup();
    await complete();

    expect(await done).toBe(true);
    expect(warned).not.toHaveBeenCalled();
  });
});
