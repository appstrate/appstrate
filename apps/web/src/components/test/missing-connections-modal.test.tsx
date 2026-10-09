// SPDX-License-Identifier: Apache-2.0

/**
 * The recovery modal of a refused launch (#1830). Its dialog chrome is a Radix
 * portal, which renders nothing without a DOM, so a row is rendered through
 * `MissingRow` and the Re-run button's state is asserted on `retryDecision`.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { render } from "../../test/render.tsx";
import { MissingRow } from "../missing-connections-modal.tsx";
import { retryDecision } from "../../lib/connection-choice.ts";
import type { MissingIntegrationFieldError } from "../../lib/connection-choice.ts";
import { refusalMessage } from "../../lib/mutation-error.ts";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

type Resolution = components["schemas"]["IntegrationAgentResolution"];

const INTEGRATION = "@acme/slack";
const AGENT = "@acme/ops";
const WEB = "11111111-1111-4111-8111-111111111111";

const fieldError = (code: string): MissingIntegrationFieldError => ({
  field: `integrations.${INTEGRATION}`,
  code,
  message: code,
});

function resolution(overrides: Partial<Resolution>): Resolution {
  return {
    source: null,
    error_code: null,
    warning: null,
    resolved_connection_ids: [],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
    org_default_connection_ids: null,
    org_default_enforced: false,
    can_add_connection: true,
    candidates: [],
    ...overrides,
  };
}

const readinessKey = (version?: string) =>
  $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
    params: {
      path: { scope: "@acme", name: "ops" },
      ...(version ? { query: { version } } : {}),
      header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
    },
  }).queryKey;

const readiness = (res: Resolution, runBlocking: boolean) => ({
  blocks_run: runBlocking,
  errors: [],
  integrations: [
    {
      integration_package_id: INTEGRATION,
      required: false,
      run_blocking: runBlocking,
      resolution: res,
    },
  ],
});

type Warning = NonNullable<Resolution["warning"]>;
const warning = (code: Warning["code"], over: Partial<Warning> = {}): Warning => ({
  field: `integrations.${INTEGRATION}`,
  code,
  message: code,
  ...over,
});

const UNBOUND = resolution({ warning: warning("not_connected") });
const BLOCKED = resolution({ error_code: "must_choose_connection" });
const label = (key: string) => i18n.t(`agents:${key}`);

function renderRow(qc: QueryClient, version?: string, code = "must_choose_connection"): string {
  return render(
    <MissingRow
      err={fieldError(code)}
      agentPackageId={AGENT}
      version={version}
      pick={null}
      onPick={() => {}}
    />,
    { queryClient: qc },
  );
}

describe("MissingRow", () => {
  it("reads the verdict of the version the refused launch ran, not the draft's", () => {
    const qc = new QueryClient();
    qc.setQueryData(readinessKey(), readiness(BLOCKED, true));
    qc.setQueryData(readinessKey("published"), readiness(UNBOUND, false));
    const refusal = refusalMessage(fieldError("must_choose_connection"))!;
    const published = renderRow(qc, "published");
    expect(published).toContain(label("detail.integrationUnbound"));
    expect(published).not.toContain(refusal);
    // Control: the draft still blocks, so its row keeps the refusal.
    const draft = renderRow(qc);
    expect(draft).toContain(refusal);
    expect(draft).not.toContain(label("detail.integrationUnbound"));
  });

  it("names why an optional integration now runs without, ahead of the resolved header", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      readinessKey(),
      readiness(
        resolution({
          warning: warning("integration_unbound", { source: "member_pin" }),
          member_pinned_connection_ids: [],
        }),
        false,
      ),
    );
    const html = renderRow(qc);
    expect(html).toContain(
      i18n.t("agents:detail.integrationUnboundNoneBy", {
        by: label("noneChosenBy.memberPin"),
      }),
    );
    expect(html).not.toContain(label("missingConnections.resolved"));
  });

  it("says resolved once the integration binds", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      readinessKey(),
      readiness(resolution({ resolved_connection_ids: [WEB] }), false),
    );
    expect(renderRow(qc)).toContain(label("missingConnections.resolved"));
  });
});

describe("retryDecision", () => {
  const mustChoose = [fieldError("must_choose_connection")];

  it("waits for every must-choose row, and takes 'no connection' (`[]`) as a pick", () => {
    expect(retryDecision(mustChoose, {})).toEqual({
      mustChoose: true,
      showRetry: true,
      canRetry: false,
    });
    expect(retryDecision(mustChoose, { [INTEGRATION]: [] }).canRetry).toBe(true);
    expect(retryDecision(mustChoose, { [INTEGRATION]: [WEB] }).canRetry).toBe(true);
    expect(retryDecision(mustChoose, { [INTEGRATION]: [] }, true).canRetry).toBe(false);
  });

  it("re-runs freely for other actionable codes, and offers no re-run when no pick can help", () => {
    expect(retryDecision([fieldError("not_connected")], {})).toEqual({
      mustChoose: false,
      showRetry: true,
      canRetry: true,
    });
    expect(retryDecision([fieldError("integration_not_active")], {}).showRetry).toBe(false);
  });
});
