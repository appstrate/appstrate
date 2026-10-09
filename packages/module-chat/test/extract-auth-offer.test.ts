// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  extractAuthOffers,
  extractRunAndWaitAuthOffers,
  isOfferExpired,
  isStartedRunResult,
  resumeInstruction,
  encodeResume,
  parseResume,
  INTEGRATION_RESUME_MARKER,
} from "../src/ui/auth-offer.ts";
import { runAndWaitSteps } from "@appstrate/core/run-and-wait-client";
import { toPiToolResult } from "../src/pi-chat/mcp-tools.ts";

const BODY = { auth_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", state: "abc-123" };
const OFFER = { connect_url: "https://app/api/integrations/connect/start?token=t" };

describe("extractAuthOffers", () => {
  it("reads the typed connectOffers at the top level and one output level down", () => {
    expect(extractAuthOffers({ content: [], connectOffers: [{ ...OFFER, state: "st" }] })).toEqual([
      { authUrl: OFFER.connect_url, state: "st" },
    ]);
    // initiateIntegrationConnect returns { connect_url, expiresAt } — no state.
    expect(
      extractAuthOffers({
        output: { connectOffers: [{ ...OFFER, expiresAt: "2026-07-15T19:08:49.000Z" }] },
      }),
    ).toEqual([{ authUrl: OFFER.connect_url, expiresAt: "2026-07-15T19:08:49.000Z" }]);
  });

  // Issue #1207: a readiness error carries one link per integration to connect,
  // and the UI mounts one card each.
  it("returns every offer, in order", () => {
    expect(
      extractAuthOffers({
        connectOffers: [
          { connect_url: "https://app/c/1", state: "st-1" },
          { connect_url: "https://app/c/2" },
        ],
      }),
    ).toEqual([{ authUrl: "https://app/c/1", state: "st-1" }, { authUrl: "https://app/c/2" }]);
  });

  // Issue #1207 phase 5: a run-kickoff 409 item names the integration it
  // connects, and the card needs that to show the right icon and name and to
  // claim the resume append.
  it("surfaces the offer's packageId", () => {
    expect(
      extractAuthOffers({
        connectOffers: [
          { ...OFFER, packageId: "@appstrate/gmail", expiresAt: "2026-07-15T19:08:49.000Z" },
        ],
      }),
    ).toEqual([
      {
        authUrl: OFFER.connect_url,
        packageId: "@appstrate/gmail",
        expiresAt: "2026-07-15T19:08:49.000Z",
      },
    ]);
    // Absent, not empty: an offer minted by a surface that names no package
    // leaves the card on its `packageId`-less path.
    expect(extractAuthOffers({ connectOffers: [OFFER] })).toEqual([{ authUrl: OFFER.connect_url }]);
  });

  it("drops the invalid entries of a list, keeping the rest (issue #906)", () => {
    expect(
      extractAuthOffers({
        connectOffers: [
          { connect_url: "/api/integrations/connect/start" },
          { connect_url: "javascript:alert(1)" },
          OFFER,
        ],
      }),
    ).toEqual([{ authUrl: OFFER.connect_url }]);
    expect(extractAuthOffers({ connectOffers: [{ connect_url: "javascript:alert(1)" }] })).toEqual(
      [],
    );
  });

  it("encodes/parses a resume message round-trip (meta + human text)", () => {
    const meta = { packageId: "@appstrate/gmail", name: "Gmail", icon: "logos:google-gmail" };
    const text = encodeResume(meta, "L'intégration Gmail est connectée. Continue.");
    expect(text.startsWith(INTEGRATION_RESUME_MARKER)).toBe(true);
    expect(text).toContain("Continue.");
    expect(parseResume(text)).toEqual(meta);
  });

  it("parseResume returns null for a normal user message", () => {
    expect(parseResume("récupère mes 3 derniers mails")).toBeNull();
  });

  it("parseResume tolerates a marker without a meta payload", () => {
    expect(parseResume(`${INTEGRATION_RESUME_MARKER}bare notice`)).toEqual({ packageId: "" });
  });

  it("returns nothing for nullish, plain-text and offer-less results", () => {
    expect(extractAuthOffers(null)).toEqual([]);
    expect(extractAuthOffers("not json")).toEqual([]);
    expect(extractAuthOffers({ content: [{ type: "text", text: "an error happened" }] })).toEqual(
      [],
    );
    expect(extractAuthOffers({ type: "content", value: [{ type: "text", text: "{}" }] })).toEqual(
      [],
    );
  });

  it("prefers the typed connectOffers channel over anything in the payload", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ connect_url: "https://stale/other" }) }],
      connectOffers: [{ connect_url: "https://app/connect/start?token=t", state: "st" }],
    };
    expect(extractAuthOffers(result)).toEqual([
      { authUrl: "https://app/connect/start?token=t", state: "st" },
    ]);
  });

  it("never scrapes a URL out of the payload — the typed field is the only channel", () => {
    // Every envelope a tool result can arrive in, each carrying a raw URL where
    // the pre-`connectOffers` deep-walk used to find one. All must yield nothing:
    // such a result predates the typed field by more than the connect session's
    // 10-minute TTL, so the URL it carries is dead (single-use token, expired).
    // The persisted `details` shape below is the exact issue-#906 report, whose
    // model channel (`content`) only ever holds the redaction placeholder.
    const placeholder = "[connect link hidden — the chat renders the connect card]";
    const legacyShapes: [name: string, shape: unknown][] = [
      [
        "ai-sdk content envelope",
        { type: "content", value: [{ type: "text", text: JSON.stringify(BODY) }] },
      ],
      [
        "raw CallToolResult",
        { content: [{ type: "text", text: JSON.stringify(BODY) }], isError: false },
      ],
      ["json envelope", { type: "json", value: BODY }],
      ["direct body", BODY],
      ["camelCase keys", { authUrl: "https://x/y", state: "s" }],
      ["top-level connect_url", { connect_url: OFFER.connect_url }],
      ["bare content array", [{ type: "text", text: JSON.stringify(BODY) }]],
      [
        "nested output envelope",
        { output: { type: "content", value: [{ type: "text", text: JSON.stringify(BODY) }] } },
      ],
      ["flat JSON string", JSON.stringify(BODY)],
      [
        "persisted details (issue #906)",
        {
          content: [{ type: "text", text: JSON.stringify({ body: { connect_url: placeholder } }) }],
          details: {
            content: [
              { type: "text", text: JSON.stringify({ body: { connect_url: "https://r" } }) },
            ],
          },
        },
      ],
    ];
    for (const [name, shape] of legacyShapes) {
      expect(extractAuthOffers(shape), `scraped a URL out of: ${name}`).toEqual([]);
    }
  });
});

describe("extractRunAndWaitAuthOffers", () => {
  const warning = {
    field: "integrations.@appstrate/gmail",
    code: "not_connected",
    message: "Gmail is not connected",
    connect_url: OFFER.connect_url,
  };

  /**
   * The parts the card renders for one call, built as the chat builds them: core's
   * own steps, wrapped by the engine's `toPiToolResult`; every step but the last is a
   * live (preliminary) chunk, the last is the settled tool result.
   */
  async function parts(run: Record<string, unknown>, maxMs?: number) {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const body = String(input).endsWith("/run")
        ? { id: "run_1", packageId: "@acme/writer", status: "pending", warnings: [warning] }
        : { id: "run_1", packageId: "@acme/writer", ...run };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const steps = [];
    for await (const step of runAndWaitSteps(
      { kind: "agent", scope: "@acme", name: "writer" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl, maxMs },
    )) {
      steps.push(step.payload);
    }
    return steps.map((payload, i) => ({
      result: toPiToolResult(payload),
      isPreliminary: i < steps.length - 1,
    }));
  }

  it("withholds a started run's offers while the call is in flight (#1830)", async () => {
    const [live] = await parts({ status: "success" });
    expect(extractRunAndWaitAuthOffers(live!)).toEqual([]);
    // The same payload settled (a page reload reads only the settled result) shows them.
    expect(extractRunAndWaitAuthOffers({ ...live!, isPreliminary: false })).toEqual([
      { authUrl: OFFER.connect_url },
    ]);
  });

  it("shows them once the call settles, whether the run ended or the wait did", async () => {
    for (const settled of [
      (await parts({ status: "success" })).at(-1)!,
      (await parts({ status: "running" }, 0)).at(-1)!,
    ]) {
      expect(extractRunAndWaitAuthOffers(settled)).toEqual([{ authUrl: OFFER.connect_url }]);
    }
  });

  it("shows them on a refused launch", () => {
    const refused = { content: [], connectOffers: [OFFER] };
    expect(extractRunAndWaitAuthOffers({ result: refused })).toEqual([
      { authUrl: OFFER.connect_url },
    ]);
  });
});

describe("isOfferExpired", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");

  // #1830: a started run's offer is minted at launch and shown at the end.
  it("is expired at and after the session's expiry", () => {
    expect(isOfferExpired("2026-10-09T12:00:00.000Z", now)).toBe(true);
    expect(isOfferExpired("2026-10-09T11:50:00.000Z", now)).toBe(true);
    expect(isOfferExpired("2026-10-09T12:00:01.000Z", now)).toBe(false);
  });

  it("treats an absent or unparseable expiry as live", () => {
    expect(isOfferExpired(undefined, now)).toBe(false);
    expect(isOfferExpired("not a date", now)).toBe(false);
  });
});

describe("resuming after a connect from run_and_wait", () => {
  const result = (payload: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

  it("tells a started run from a refused launch", () => {
    expect(isStartedRunResult(result({ id: "run_1", done: true }))).toBe(true);
    expect(isStartedRunResult(result({ id: "run_1", done: false }))).toBe(true);
    expect(isStartedRunResult(result({ status: 409, body: {} }))).toBe(false);
  });

  // #1830: a run that already finished without the integration is not re-run on
  // the model's initiative; a refused launch still continues the task.
  it("continues the task only after a refused launch", () => {
    expect(resumeInstruction("Gmail", false)).toBe(
      "L'intégration Gmail est maintenant connectée. Continue la tâche.",
    );
    const afterRun = resumeInstruction("Gmail", true);
    expect(afterRun).toStartWith("L'intégration Gmail est maintenant connectée.");
    expect(afterRun).not.toContain("Continue la tâche");
    expect(afterRun).toContain("Ne relance pas l'agent");
  });
});
