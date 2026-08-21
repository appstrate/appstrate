// SPDX-License-Identifier: Apache-2.0

/**
 * `useScheduleFormDeps` — the null contract the schedule editor depends on.
 *
 * `ScheduleForm` seeds its input state ONCE, in a `useState` initialiser, from
 * the agent's stored values + locks. A locked field seeded into that state can
 * never leave it (the launch form only ever deletes prompted / pre-filled keys)
 * and the save is then refused with 400 `locked_input_field` — an unsaveable
 * schedule with no way out through the UI. The seed is only correct if the form
 * mounts with the REAL settings, which is what the hook's `null` return is for:
 * no agent detail yet → no deps → the page renders its loading state instead of
 * mounting the form on empty settings.
 *
 * The web test runner has no DOM, so the form is stood in for by a probe doing
 * the same two steps the page and the `useState` initialiser do: bail on `null`
 * deps, otherwise seed with `initialInputValues` — the very function
 * `ScheduleForm` calls, whose result is what the form submits when the user
 * edits nothing but the cron.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail } from "@appstrate/shared-types";
import { packageKeys } from "../../lib/query-keys.ts";
import { initialInputValues, type AgentInputSettings } from "../../lib/agent-input.ts";
import { useScheduleFormDeps } from "../use-schedules.ts";

const PACKAGE_ID = "@myorg/mailer";

/**
 * Zustand's `useStore` reads the store's INITIAL state for its server snapshot,
 * so the org / application ids are `null` under `renderToStaticMarkup` — the
 * detail cache key carries those nulls verbatim.
 */
const DETAIL_KEY = packageKeys.detail("agents", null, null, PACKAGE_ID, "draft");

/** `folder` was locked AFTER the schedule below froze `folder: "inbox"`. */
const AGENT_DETAIL = {
  id: PACKAGE_ID,
  version: "1.0.0",
  dependencies: { skills: [], mcp_servers: [], integrations: [] },
  input: {
    schema: {
      type: "object",
      properties: { folder: { type: "string" }, query: { type: "string" } },
    },
    values: { folder: "archive" },
    locked_fields: ["folder"],
  },
} as unknown as AgentDetail;

const STORED_SCHEDULE_INPUT = { folder: "inbox", query: "invoices" };

const EMPTY_SETTINGS: AgentInputSettings = { values: {}, locked_fields: [] };

function Probe() {
  const deps = useScheduleFormDeps(PACKAGE_ID);
  // The page renders its loading state until the deps resolve.
  if (!deps) return <>loading</>;
  // What `ScheduleForm`'s `useState` initialiser computes on mount — and what
  // the form submits when the user changes nothing but the cron.
  const settings: AgentInputSettings = deps.inputWrapper ?? EMPTY_SETTINGS;
  const seed = initialInputValues(deps.inputWrapper, settings, STORED_SCHEDULE_INPUT);
  return <>{Object.keys(seed).sort().join(",")}</>;
}

function render(qc: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("useScheduleFormDeps", () => {
  it("returns null while the agent detail is still in flight", () => {
    expect(render(new QueryClient())).toBe("loading");
  });

  it("strips a locked field from the schedule's stored input once the detail lands", () => {
    const qc = new QueryClient();
    qc.setQueryData(DETAIL_KEY, AGENT_DETAIL);
    expect(render(qc)).toBe("query");
  });
});
