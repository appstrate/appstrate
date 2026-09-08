/**
 * `quoteUsage` — the pure per-component credit estimate admission gates on.
 *
 * Rates are injected (never read from module scope), so these tests can prove
 * the phase-2 behaviour — compute billing enabled — without `mock.module()`.
 */
import { describe, expect, it } from "bun:test";
import {
  quoteUsage,
  assertExecutionFacts,
  type QuoteRates,
} from "../../src/billing/usage-quote.ts";
import type { BeforeUsageParams } from "@appstrate/core/module";
import { ApiError } from "@appstrate/core/api-errors";
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

  describe("execution-fact refusal", () => {
    /**
     * The wire shape a platform below this module's declared `@appstrate/core`
     * floor produces. The fields are typed as required, so building it needs a
     * cast — legitimate here because these tests pin that the shape is REFUSED.
     * A cast that pinned it WORKING is what would keep a compatibility branch
     * alive; there is no longer one to keep.
     */
    function unrecognizedRun(overrides: Record<string, unknown> = {}): BeforeUsageParams {
      return {
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 2,
        ...overrides,
      } as unknown as BeforeUsageParams;
    }

    /** Run `fn`, returning whatever it threw. Fails if it threw nothing. */
    function thrownBy(fn: () => void): unknown {
      try {
        fn();
      } catch (err) {
        return err;
      }
      throw new Error("expected a refusal, got none");
    }

    it("refuses with an ApiError when the platform sent no execution facts", () => {
      // The CLASS is the assertion that matters, not the wording: the scheduler
      // branches on `instanceof ApiError` to record a failed run, and the HTTP
      // error handler branches on it to preserve the status. A bare `Error`
      // passes a message-only assertion while degrading on both seams.
      const err = thrownBy(() => assertExecutionFacts(unrecognizedRun()));
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("platform_version_unsupported");
    });

    it("refuses with a terminal 4xx, so the Pi SDK's 429/5xx retry does not storm it", () => {
      const err = thrownBy(() => assertExecutionFacts(unrecognizedRun())) as ApiError;
      expect(err.status).toBe(409);
      expect(err.status).toBeGreaterThanOrEqual(400);
      expect(err.status).toBeLessThan(500);
      expect(err.status).not.toBe(429);
    });

    it("refuses values outside the documented unions, not only missing ones", () => {
      const err = thrownBy(() =>
        assertExecutionFacts(
          unrecognizedRun({ credentialSource: "bogus", executionPlane: "sandbox" }),
        ),
      ) as ApiError;
      expect(err.code).toBe("platform_version_unsupported");
    });

    it("keeps the received values off the wire — they are logged, not surfaced (#50)", () => {
      // `message` becomes the RFC 9457 `detail`, and the scheduler writes it
      // verbatim onto a failed run row an org member reads.
      const err = thrownBy(() =>
        assertExecutionFacts(
          unrecognizedRun({ credentialSource: "bogus", executionPlane: "sandbox" }),
        ),
      ) as ApiError;
      expect(err.message).not.toContain("bogus");
      expect(err.message).not.toContain("sandbox");
      expect(err.message).not.toContain("credentialSource");
      expect(err.message).not.toContain("9.0.0");
    });

    it("refuses a chat turn the same way", () => {
      const chat = {
        orgId,
        context: "chat",
        sessionId: "sess-1",
        // `null` is legal on a run and NOT on chat, whose unions are narrower.
        credentialSource: null,
        executionPlane: "platform",
      } as unknown as BeforeUsageParams;
      const err = thrownBy(() => assertExecutionFacts(chat));
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("platform_version_unsupported");
    });

    it("refuses a remote plane on chat, which only ever executes in-process", () => {
      const chat = {
        orgId,
        context: "chat",
        sessionId: "sess-2",
        credentialSource: "org",
        executionPlane: "remote",
      } as unknown as BeforeUsageParams;
      expect(() => assertExecutionFacts(chat)).toThrow(ApiError);
    });
  });

  describe("execution facts a current platform reports", () => {
    // Every combination the two unions admit, so a narrowing of the accepted
    // set cannot pass as a passing suite. The run variant takes three credential
    // sources across two planes; chat takes two sources on the platform plane
    // only. `timeoutSeconds` is not validated here — it is quoted, not asserted.
    const runCases: Array<["system" | "org" | null, "platform" | "remote"]> = [
      ["system", "platform"],
      ["system", "remote"],
      ["org", "platform"],
      ["org", "remote"],
      [null, "platform"],
      [null, "remote"],
    ];

    for (const [credentialSource, executionPlane] of runCases) {
      it(`admits a run with credentialSource=${JSON.stringify(credentialSource)} on the ${executionPlane} plane`, () => {
        expect(() =>
          assertExecutionFacts({
            orgId,
            context: "run",
            packageId: "@x/agent",
            runningCount: 1,
            credentialSource,
            executionPlane,
            timeoutSeconds: 300,
          }),
        ).not.toThrow();
      });
    }

    for (const credentialSource of ["system", "org"] as const) {
      it(`admits a chat turn with credentialSource=${credentialSource} on the platform plane`, () => {
        expect(() =>
          assertExecutionFacts({
            orgId,
            context: "chat",
            sessionId: null,
            credentialSource,
            executionPlane: "platform",
          }),
        ).not.toThrow();
      });
    }
  });
});
