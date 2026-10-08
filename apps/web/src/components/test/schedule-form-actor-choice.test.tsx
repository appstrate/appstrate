// SPDX-License-Identifier: Apache-2.0

/**
 * The schedule form feeds the other-actor connection section from the agent detail of the
 * version the fires run: an integration that version marks `required` is never offered
 * "No connection", whose save the server would refuse.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

// Registered before the fake storage's own teardown, so it runs first.
afterAll(async () => {
  for (let i = 0; i < 50 && authStore.getState().loading; i++) await Bun.sleep(1);
  getSession.mockRestore();
});

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { ScheduleForm } = await import("../schedule-form.tsx");
const { render } = await import("../../test/render.tsx");
const { packageKeys } = await import("../../lib/query-keys.ts");
const i18nModule = await import("../../i18n.ts");
const { authClient } = await import("../../lib/auth-client.ts");
const { authStore } = await import("../../stores/auth-store.ts");

// The form's `useAuth()` starts the session resync: answer it at once (no session) and let it
// settle inside this suite, while the fake storage it clears still exists.
const getSession = spyOn(authClient, "getSession").mockResolvedValue({
  data: null,
  error: null,
});

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const AGENT = "@acme/mailer";
const GMAIL = "@acme/gmail";
const SLACK = "@acme/slack";
const VERSION = "1.0.0";

function renderForm(integrations: { id: string; required?: boolean }[]): string {
  const qc = new QueryClient();
  // Org and space ids are `null` under a static render; the key carries them verbatim.
  qc.setQueryData(packageKeys.detail("agents", null, null, AGENT, VERSION), {
    id: AGENT,
    version: VERSION,
    dependencies: {
      skills: [],
      mcp_servers: [],
      integrations: integrations.map((i) => ({ version: "^1.0.0", ...i })),
    },
  });
  return render(
    <ScheduleForm
      mode="edit"
      packageId={AGENT}
      // A frozen version opens the overrides section, where the connection choice sits.
      defaultValues={{ cron_expression: "0 9 * * *", version_override: VERSION }}
      currentActor={{ userId: "usr_bob" }}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
    { queryClient: qc },
  );
}

describe("ScheduleForm — another member's schedule", () => {
  it("offers 'No connection' only for the integrations the fired version does not require", () => {
    const html = renderForm([{ id: GMAIL, required: true }, { id: SLACK }]);
    expect(html).toContain('data-testid="schedule-actor-connections"');
    expect(html).toContain(`schedule-actor-none-${SLACK}`);
    expect(html).toContain(`sched-none-${SLACK}`);
    expect(html).not.toContain(`schedule-actor-none-${GMAIL}`);
    expect(html).not.toContain(`sched-none-${GMAIL}`);
  });

  it("offers it for an integration once the agent stops requiring it", () => {
    const html = renderForm([{ id: GMAIL, required: false }]);
    expect(html).toContain(`sched-none-${GMAIL}`);
  });
});
