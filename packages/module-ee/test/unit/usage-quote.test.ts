// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `quoteUsage` — the pure per-component credit estimate admission gates on.
 *
 * Rates are injected (never read from module scope), so these tests can prove
 * the phase-2 behaviour — compute billing enabled — without `mock.module()`.
 */
import { describe, expect, it } from "bun:test";
import { quoteUsage, type QuoteRates } from "../../src/billing/usage-quote.ts";
import { DEFAULT_QUOTE_RATES } from "../../src/config.ts";

const orgId = "00000000-0000-4000-a000-0000000009a0";

/** Production rates: model estimates live, compute rates at 0 (phase 1). */
const PROD: QuoteRates = DEFAULT_QUOTE_RATES;

/** Phase-2 fixture: compute billing switched on by config alone. */
const WITH_COMPUTE: QuoteRates = {
  ...DEFAULT_QUOTE_RATES,
  computeCreditsPerRunSecond: 2,
  computeCreditsPerChatTurn: 5,
};

describe("quoteUsage", () => {
  describe("runs", () => {
    it("quotes a system run at the per-run model estimate × the in-flight count", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 3,
          credentialSource: "system",
          executionPlane: "platform",
          timeoutSeconds: 600,
        },
        PROD,
      );
      expect(quote.modelCredits).toBe(200 * 3);
      expect(quote.computeCredits).toBe(0);
      expect(quote.totalCredits).toBe(600);
    });

    it("quotes a platform BYOK run at zero — the org funds the inference", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 5,
          credentialSource: "org",
          executionPlane: "platform",
          timeoutSeconds: 900,
        },
        PROD,
      );
      expect(quote.modelCredits).toBe(0);
      expect(quote.computeCredits).toBe(0);
      expect(quote.totalCredits).toBe(0);
    });

    it("quotes a platform BYOK run above zero once the compute rate is non-zero", () => {
      // Acceptance 5: enabling compute billing is a rate change only — the
      // facts, the call graph and the admission seam are unchanged.
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: "org",
          executionPlane: "platform",
          timeoutSeconds: 300,
        },
        WITH_COMPUTE,
      );
      expect(quote.modelCredits).toBe(0);
      expect(quote.computeCredits).toBe(2 * 300);
      expect(quote.totalCredits).toBe(600);
      expect(quote.totalCredits).toBeGreaterThan(0);
    });

    it("quotes a remote BYOK run at zero on every component", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 4,
          credentialSource: "org",
          executionPlane: "remote",
          timeoutSeconds: 1800,
        },
        WITH_COMPUTE,
      );
      expect(quote).toEqual({ modelCredits: 0, computeCredits: 0, totalCredits: 0 });
    });

    it("quotes a remote run with an undeterminable credential source at zero", () => {
      // A remote-origin run resolves its model on its own host; any inference
      // it later routes through the system proxy is admitted at that seam.
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: null,
          executionPlane: "remote",
          timeoutSeconds: null,
        },
        WITH_COMPUTE,
      );
      expect(quote.modelCredits).toBe(0);
      expect(quote.computeCredits).toBe(0);
    });

    it("quotes zero compute for a platform run with a null timeout, even at a non-zero rate", () => {
      // The system-proxy seam admits inference for an ALREADY-RUNNING platform
      // run whose compute was quoted at its own preflight. Reading `null` as
      // "unknown, assume the worst" would double-count that compute.
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: "system",
          executionPlane: "platform",
          timeoutSeconds: null,
        },
        WITH_COMPUTE,
      );
      expect(quote.computeCredits).toBe(0);
      expect(quote.modelCredits).toBe(200);
      expect(quote.totalCredits).toBe(200);
    });

    it("never emits NaN for a null timeout (the arithmetic is guarded, not attempted)", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: "org",
          executionPlane: "platform",
          timeoutSeconds: null,
        },
        WITH_COMPUTE,
      );
      expect(Number.isFinite(quote.totalCredits)).toBe(true);
      expect(quote.totalCredits).toBe(0);
    });
  });

  describe("chat", () => {
    it("quotes a system chat turn at the flat per-turn model estimate", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "chat",
          sessionId: "sess-1",
          credentialSource: "system",
          executionPlane: "platform",
        },
        PROD,
      );
      expect(quote.modelCredits).toBe(20);
      expect(quote.computeCredits).toBe(0);
      expect(quote.totalCredits).toBe(20);
    });

    it("quotes an org-credentialed chat turn at zero model credits", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "chat",
          sessionId: null,
          credentialSource: "org",
          executionPlane: "platform",
        },
        PROD,
      );
      expect(quote.modelCredits).toBe(0);
      expect(quote.totalCredits).toBe(0);
    });

    it("adds the per-turn compute component once its rate is non-zero", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "chat",
          sessionId: "sess-2",
          credentialSource: "org",
          executionPlane: "platform",
        },
        WITH_COMPUTE,
      );
      expect(quote.computeCredits).toBe(5);
      expect(quote.totalCredits).toBe(5);
    });
  });

  describe("rounding and clamping", () => {
    it("rounds a sub-credit compute component UP instead of silently to zero", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: "org",
          executionPlane: "platform",
          timeoutSeconds: 30,
        },
        { ...DEFAULT_QUOTE_RATES, computeCreditsPerRunSecond: 0.001 },
      );
      // 0.001 × 30 = 0.03 credits → ceil → 1, not 0.
      expect(quote.computeCredits).toBe(1);
      expect(quote.totalCredits).toBe(1);
    });

    it("rounds each component up independently before summing", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: "system",
          executionPlane: "platform",
          timeoutSeconds: 10,
        },
        {
          modelCreditsPerRun: 0.4,
          modelCreditsPerChatTurn: 0,
          computeCreditsPerRunSecond: 0.05,
          computeCreditsPerChatTurn: 0,
        },
      );
      // model 0.4 → 1, compute 0.5 → 1, total 2 (not ceil(0.9) === 1).
      expect(quote.modelCredits).toBe(1);
      expect(quote.computeCredits).toBe(1);
      expect(quote.totalCredits).toBe(2);
    });

    it("clamps a non-finite rate to 0 rather than poisoning the total with NaN", () => {
      // A NaN total would compare false against the remaining balance and
      // silently ADMIT everything — the opposite of the fail-closed posture.
      const quote = quoteUsage(
        {
          orgId,
          context: "run",
          packageId: "@x/agent",
          runningCount: 1,
          credentialSource: "system",
          executionPlane: "platform",
          timeoutSeconds: 60,
        },
        { ...DEFAULT_QUOTE_RATES, modelCreditsPerRun: Number.NaN },
      );
      expect(quote.modelCredits).toBe(0);
      expect(quote.totalCredits).toBe(0);
    });

    it("clamps a negative component to 0", () => {
      const quote = quoteUsage(
        {
          orgId,
          context: "chat",
          sessionId: "sess-3",
          credentialSource: "system",
          executionPlane: "platform",
        },
        { ...DEFAULT_QUOTE_RATES, modelCreditsPerChatTurn: -50 },
      );
      expect(quote.modelCredits).toBe(0);
      expect(quote.totalCredits).toBe(0);
    });
  });
});
