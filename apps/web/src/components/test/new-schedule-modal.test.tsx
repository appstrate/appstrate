// SPDX-License-Identifier: Apache-2.0

/**
 * The new-schedule form. A new schedule fires every day at 9, in UTC. Who it runs as, the version
 * and the model are chosen in the same create, folded: an agent never published fires only its
 * draft, and a model no organization credential serves is refused. Running as its creator, the
 * create names the connection the creator's fallback binds, from their verdict for the version
 * the fires run.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AgentDetail } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

// Registered before the fake storage's own teardown, so it runs first.
afterAll(() => getSession.mockRestore());

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { ScheduleFieldsReady } = await import("../new-schedule-modal.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const { authClient } = await import("../../lib/auth-client.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { startAuthBootstrap } = await import("../../hooks/use-auth.ts");

const getSession = spyOn(authClient, "getSession").mockResolvedValue({
  data: null,
  error: null,
});
startAuthBootstrap();
for (let i = 0; i < 5000 && authStore.getState().loading; i++) await Bun.sleep(1);

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const t = (key: string) => i18nModule.default.t(`agents:${key}`);

const DEPS = {
  inputWrapper: {
    schema: { type: "object", properties: {} },
    values: {},
    locked_fields: [],
  } as unknown as AgentDetail["input"],
  persistedModelId: null,
  persistedGenerationConfig: null,
  persistedProxyId: null,
  homeWritable: true,
  hasFileInputs: false,
  agentIntegrations: [],
  skills: [],
};

function renderForm(qc = new QueryClient()): string {
  const snapshot = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: "usr_bob", email: "bob@acme.test", emailVerified: true },
  });
  try {
    return render(
      <ScheduleFieldsReady
        deps={DEPS}
        agentId="@acme/mailer"
        onCreated={() => {}}
        onCancel={() => {}}
      />,
      { queryClient: qc },
    );
  } finally {
    snapshot.mockRestore();
  }
}

describe("ScheduleFieldsReady", () => {
  it("starts every day at 9, in UTC, wherever its author's browser is", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Toronto";
    let html: string;
    try {
      html = renderForm();
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    expect(html).toContain('value="09:00"');
    expect(html).toMatch(/id="frequency-timezone"[^>]*>(<[^>]+>)*UTC</);
  });

  it("offers who it runs as, the version and the model in the create itself", () => {
    const html = renderForm();
    expect(html).toContain(t("schedule.optionsTitle"));
  });

  it("asks no readiness verdict to write: the server names the creator's fallback", () => {
    const qc = new QueryClient();
    renderForm(qc);
    const asked = qc
      .getQueryCache()
      .getAll()
      .some(({ queryKey: [, path] }) => path === "/api/agents/{scope}/{name}/connection-readiness");
    expect(asked).toBe(false);
  });
});
