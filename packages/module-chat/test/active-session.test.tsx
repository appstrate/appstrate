// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's server row (`generating`, `updatedAt`, `unread`), which drives the
 * history self-heal and the mark-read: a conversation opens in place whatever the list's filter,
 * so a row the filtered list lacks comes from the conversation itself.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useActiveSession } from "../src/ui/use-sessions.ts";
import {
  sessionQueryKey,
  sessionsQueryKey,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";
import { transportOf } from "./fake-request.ts";

const row: SessionSummary = {
  id: "chs_1",
  title: "T",
  generating: false,
  unread: true,
  updatedAt: "2026-11-16T10:00:00.000Z",
  spaceId: "spc_b",
  restricted: false,
  space_ids: ["spc_b"],
};
const detail: SessionHistory = {
  ...row,
  messages: [],
  skills: { skillDiscovery: true, pins: [] },
  createdAt: "",
};
const list = (rows: SessionSummary[]): SessionsCache => ({
  pages: [{ data: rows, hasMore: false }],
  pageParams: [undefined],
});

// The list is filtered to spc_a.
const transport = transportOf(() => ({}), "spc_a");

function activeRow(qc: QueryClient, persisted = true): SessionSummary | undefined {
  let seen: SessionSummary | undefined;
  function Harness() {
    seen = useActiveSession(transport, "chs_1", persisted);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  return seen;
}

describe("the open conversation's server row", () => {
  it("is the conversation itself when the filtered list lacks it", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionsQueryKey("spc_a"), list([]));
    qc.setQueryData(sessionQueryKey("org_1", "chs_1"), detail);
    expect(activeRow(qc)).toMatchObject({
      generating: false,
      unread: true,
      updatedAt: row.updatedAt,
    });
  });

  it("is the list's row when the list holds it (fresher during a local turn)", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionsQueryKey("spc_a"), list([{ ...row, generating: true }]));
    qc.setQueryData(sessionQueryKey("org_1", "chs_1"), detail);
    expect(activeRow(qc)?.generating).toBe(true);
  });

  it("is the list's row alone for a conversation not created yet", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionQueryKey("org_1", "chs_1"), detail);
    expect(activeRow(qc, false)).toBeUndefined();
  });
});
